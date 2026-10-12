// WHAT THIS KEEPER ASKS OF ITS RPC PROVIDER, AND WHAT THAT COSTS IN CREDITS:
// per method, per sweep and per day, counted where every request passes.
//
// WHY IT EXISTS (ADR L1a, "instrument before cutting"). Today's first wall is
// Helius's 10M credits a month, reached at 8–26 users depending on a price
// nobody has settled, and every cut on the roadmap is justified by a credit
// number nobody can check: the dashboard shows "Kepper-Vol" at 50.3k requests a
// day (MEASURED) where the volume keeper's code should make about 15.8k
// (COMPUTED, COST_MODEL §5.2). A third consumer on a key hides a cut's saving or
// fakes one. So before any cut ships,
// each keeper says on /status what it asked for, method by method, and the
// owner compares that with each key's line on the dashboard.
//
// COUNTED IN THE TRANSPORT (rpc-pool.ts), FROM THE JSON-RPC BODY, because that
// is the one place every request passes — Anchor's reads, the walk, the settle
// and invest sends — and the body is the only place the method is written. A
// batch counts per item: Helius does not say whether it bills a batch per item
// or per request, and per item is the reading its own limits page implies
// (helius/credits.md §1).
//
// WHAT IS COUNTED IS WHAT WAS ASKED. A request is counted once, when the pool is
// handed it, whichever endpoint answers and whether any does. The endpoints'
// own answers are counted beside it (byEndpointPerDay), so a day spent on the
// fallback endpoint — which is not on the Helius bill — reads as exactly that.
//
// IT DECIDES NOTHING ABOUT MONEY, like src/sweep-cost.ts. The pool reports to it
// after choosing an endpoint and never reads it back; its one alert compares a
// number with a budget the owner set; and every entry point swallows its own
// failure, because a counter that can break a request is a counter that can
// stop a settle.

import type { Alert } from "./alerts.js";
import { DAY_BUCKET_MS, DAY_MS, MIN_OBSERVED_FOR_ESTIMATE_MS, createRollingCounts, scaledToWindow, type RollingCounts } from "./rolling-counts.js";

/**
 * What an archival call costs, in credits: 1 or 10. The ADR's P1 and P2.
 *
 * HELIUS'S OWN PAGES DISAGREE (helius/credits.md §0.1, both downloaded in the
 * same minute on 2026-10-11). Its billing page — the page that says what an
 * account is charged — prices every historical call at 1
 * (raw/billing_credits.md:145, rows :178 and :184); its pricing FAQ and its
 * API-reference index say 10. The keeper calls getSignaturesForAddress for
 * every link on every sweep, so this decides a factor of up to ten on the
 * largest line of the bill, and only the owner's Admin API read (ADR §2.5, E1)
 * settles it.
 */
export type ArchivalCredits = 1 | 10;

/**
 * SIP_SOLANA_ARCHIVAL_CREDITS when it is unset: 1.
 *
 * WHY 1, AND NOT THE 10 THE ROLLOUT TABLE PROPOSED "UNTIL E1 ANSWERS":
 *   * 1 IS WHAT THE BILLING PAGE SAYS, and the billing page is the document that
 *     describes the charge; 10 is the marketing FAQ's and the API index's.
 *     Picking the larger number by default would be picking the page that is
 *     not about billing.
 *   * NOTHING HIDES BEHIND THE DEFAULT. /status serves the estimate at BOTH
 *     prices side by side (creditsPerDayEstimateP1 and …P2) and the archival
 *     calls on their own, so the 10× reading is on the page whichever price is
 *     configured.
 *   * THE ONLY THING THE PRICE MOVES IS AN ESTIMATE ON /status. credit-burn
 *     fires only once the owner sets SIP_SOLANA_CREDIT_BUDGET_DAY, and while
 *     this default is in force it does NOT use it: it compares the HIGHER
 *     reading against the budget (creditBurnAlert), because a budget may well
 *     be set before E1 answers, and an early warning that assumed the cheaper
 *     price would stay silent at twice the budget. Its message names both
 *     readings too.
 *   * A WRONG 10 IS ALSO A WRONG NUMBER. Ten times the bill on /status is the
 *     kind of figure that gets a cut prioritised, or credits bought, for a
 *     cost that may not exist.
 * Once E1 has answered, the variable is set to what it said and this default
 * stops mattering.
 */
export const DEFAULT_ARCHIVAL_CREDITS: ArchivalCredits = 1;

/**
 * The lines of a Helius bill this keeper can run up, each priced by
 * creditPrice below.
 *
 *   * standard            — every JSON-RPC method not listed separately: 1.
 *   * programAccounts     — getProgramAccounts: 10 (raw/billing_credits.md:94-96).
 *   * programAccountsV2   — getProgramAccountsV2: 1 (:100-102). Called only
 *                           under C6 (`gpa-v2`, src/discovery.ts), one per
 *                           page, over the same pooled fetch, so it is metered
 *                           here; a sweep that falls back is billed its
 *                           getProgramAccounts on top.
 *   * archival            — the historical calls, ArchivalCredits each.
 *   * webSocketConfirmation — one Anchor confirmTransaction, which listens on
 *                           the Connection's websocket. Helius bills a websocket
 *                           1 credit per connection opened plus 2 per 0.1 MB
 *                           (raw/rpc_websocket.md:48,53); web3.js opens the
 *                           socket for the subscription and closes it 500 ms
 *                           after the last one ends (Connection's
 *                           _rpcWebSocketIdleTimeout), so each confirmation is
 *                           priced as the connection it most likely opened, and
 *                           its few hundred bytes as 0 (ASSUMED).
 *   * webhookEvent        — a transaction Helius delivered to the doorbell: 1,
 *                           billed even when the endpoint refuses it (:527-529).
 *   * webhookWrite        — a webhook create, edit or delete: 100 (:533-535).
 *   * webhookUnpriced     — a webhook list, get or toggle. NO PAGE PRICES THESE
 *                           (credits.md §0.3), so they are counted and priced
 *                           at 0: the dashboard's daily chart is what tells 0
 *                           from 1 from 100, and the count is here to multiply.
 */
export type CreditClass =
  | "standard"
  | "programAccounts"
  | "programAccountsV2"
  | "archival"
  | "webSocketConfirmation"
  | "webhookEvent"
  | "webhookWrite"
  | "webhookUnpriced";

/**
 * The historical ("archival") methods, from the billing page's own table
 * (raw/billing_credits.md:145-204). getSignatureStatuses is archival only when
 * it searches the history (creditClassOf), which the settle's own landing poll
 * does (settle-tick.ts).
 */
export const ARCHIVAL_METHODS: ReadonlySet<string> = new Set([
  "getBlock",
  "getBlocks",
  "getBlocksWithLimit",
  "getBlockTime",
  "getInflationReward",
  "getSignaturesForAddress",
  "getTransaction",
]);

/**
 * Which line of the bill one JSON-RPC call lands on.
 *
 * getSignatureStatuses IS THE ONE METHOD WHOSE PRICE DEPENDS ON ITS PARAMS: the
 * API-reference index prices it at 10 "if searchTransactionHistory: true" and
 * at 1 otherwise (raw/api-reference_rpc_http_llms.txt:100), and the billing
 * page lists it among the historical calls. Both readings agree it is the
 * archival price when the history is searched, so it is filed there exactly
 * then.
 */
export function creditClassOf(method: string, params: unknown): CreditClass {
  if (method === "getProgramAccounts") return "programAccounts";
  if (method === "getProgramAccountsV2") return "programAccountsV2";
  if (ARCHIVAL_METHODS.has(method)) return "archival";
  if (method === "getSignatureStatuses" && Array.isArray(params)) {
    const options: unknown = params[1];
    if (typeof options === "object" && options !== null && (options as { searchTransactionHistory?: unknown }).searchTransactionHistory === true) {
      return "archival";
    }
  }
  return "standard";
}

/** What one call on each line costs, at a given archival price. */
export function creditPrice(line: CreditClass, archivalCredits: ArchivalCredits): number {
  switch (line) {
    case "standard":
    case "programAccountsV2":
    case "webSocketConfirmation":
    case "webhookEvent":
      return 1;
    case "programAccounts":
      return 10;
    case "archival":
      return archivalCredits;
    case "webhookWrite":
      return 100;
    case "webhookUnpriced":
      return 0;
  }
}

/** Every line, in the order /status lists them. */
export const CREDIT_CLASSES: readonly CreditClass[] = [
  "standard",
  "programAccounts",
  "programAccountsV2",
  "archival",
  "webSocketConfirmation",
  "webhookEvent",
  "webhookWrite",
  "webhookUnpriced",
];

/** Credits for a set of per-line counts at one archival price. */
export function creditsFor(lines: Readonly<Record<string, number>>, archivalCredits: ArchivalCredits): number {
  let credits = 0;
  for (const line of CREDIT_CLASSES) credits += (lines[line] ?? 0) * creditPrice(line, archivalCredits);
  return credits;
}

/** The method name of a body nobody could read, or that named none. */
export const UNREADABLE_METHOD = "unreadable";

/** A JSON-RPC method name as web3.js writes one; anything else is counted as UNREADABLE_METHOD, never echoed. */
const METHOD_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The calls one request body carries: one for a call, one per item for a
 * batch, and one UNREADABLE_METHOD for a body that is not JSON-RPC at all —
 * because a request went out either way, and a count that dropped it would read
 * as a smaller bill.
 *
 * ONLY THE METHOD AND THE PARAMS' SHAPE ARE LOOKED AT, and only the method
 * leaves this function as a string; a name that is not shaped like one is
 * replaced, never repeated, so nothing from a body can reach /status.
 */
export function jsonRpcCalls(body: unknown): readonly { readonly method: string; readonly params: unknown }[] {
  if (typeof body !== "string") return [{ method: UNREADABLE_METHOD, params: undefined }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [{ method: UNREADABLE_METHOD, params: undefined }];
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return [{ method: UNREADABLE_METHOD, params: undefined }];
  return items.map((item) => {
    const method = typeof item === "object" && item !== null ? (item as { method?: unknown }).method : undefined;
    const params = typeof item === "object" && item !== null ? (item as { params?: unknown }).params : undefined;
    return { method: typeof method === "string" && METHOD_SHAPE.test(method) ? method : UNREADABLE_METHOD, params };
  });
}

/**
 * What the RPC pool tells its meter (rpc-pool.ts, poolFetch). Two facts, both
 * after the fact: a request it was handed, and how one attempt at one endpoint
 * ended — an HTTP status, or "unreachable" for a request that never got one.
 */
export interface RpcMeter {
  request(body: unknown): void;
  attempt(at: string, result: number | "unreachable"): void;
}

/** How one endpoint's attempts ended over the day. */
export interface EndpointDay {
  readonly answered: number;
  readonly http429: number;
  readonly httpOther: number;
  readonly unreachable: number;
}

/**
 * The `rpc` block of /status (ADR §6.3, [ROLLOUT] §6 rows 1–3).
 *
 * "PER DAY" IS THE LAST 24 HOURS THIS PROCESS SAW, NOT AN EXTRAPOLATION:
 * `observedMs` says how much of the day that is, and a keeper redeployed an
 * hour ago reports an hour. The one number scaled to a whole day is the credit
 * estimate, because a budget is per day; it is served at both archival prices.
 */
export interface RpcUsageStatus {
  readonly archivalCredits: ArchivalCredits;
  /** "env" once SIP_SOLANA_ARCHIVAL_CREDITS is set (E1 answered); "default" while it is the unsettled 1. */
  readonly archivalCreditsSource: "default" | "env";
  /** JSON-RPC calls the last completed sweep asked for, in total and by method. Null until one completes. */
  readonly callsLastSweep: number | null;
  readonly byMethodLastSweep: Readonly<Record<string, number>> | null;
  /** The last sweep's credits at the configured archival price, websocket confirmations and webhook traffic included. */
  readonly creditsLastSweep: number | null;
  /** How much of the last 24 h the per-day counts below cover. */
  readonly observedMs: number;
  readonly callsPerDay: number;
  readonly byMethodPerDay: Readonly<Record<string, number>>;
  /** Calls, confirmations, webhook events and webhook requests, by the line of the bill each one lands on. */
  readonly byCreditClassPerDay: Readonly<Record<string, number>>;
  /** Anchor confirmTransaction calls: each one listens on a websocket the pool never sees. */
  readonly webSocketConfirmationsPerDay: number;
  /** Helius's REST API, by verb: the doorbell's webhook list (GET), create (POST), edit (PUT) and toggle (PATCH). */
  readonly heliusRestPerDay: Readonly<Record<string, number>>;
  /** Transactions Helius delivered to the doorbell, each billed one credit. */
  readonly webhookEventsPerDay: number;
  /** The credits of the observed window itself, at the configured archival price: never scaled, so never wild. */
  readonly creditsObserved: number;
  /**
   * The day's credits at the configured archival price, scaled to 24 h when less
   * was observed. NULL until MIN_OBSERVED_FOR_ESTIMATE_MS has been observed: a
   * first sweep scaled up from a fraction of a second is not an estimate.
   */
  readonly creditsPerDayEstimate: number | null;
  /** The same at archival = 1 (P1) and at archival = 10 (P2), whichever is configured. */
  readonly creditsPerDayEstimateP1: number | null;
  readonly creditsPerDayEstimateP2: number | null;
  /** SIP_SOLANA_CREDIT_BUDGET_DAY, or null: no budget, and then no credit-burn alert. */
  readonly budgetPerDay: number | null;
  /**
   * The estimate as a share of the budget, in percent. A month at today's daily
   * rate against a month of daily budgets is the same ratio, which is why the
   * ADR's name for it says "month". Null without a budget.
   */
  readonly projectedMonthPct: number | null;
  /** HTTP 429 answers since this process came up, and in the day. A Helius key out of credits answers 429 "max usage". */
  readonly http429: number;
  readonly http429PerDay: number;
  readonly byEndpointPerDay: Readonly<Record<string, EndpointDay>>;
  /** How long the endpoint answering now has answered without another one answering in between. Null until one has. */
  readonly endpointSinceMs: number | null;
}

/** The meter the keeper holds: the pool's half plus everything that is not a JSON-RPC request. */
export interface RpcUsage extends RpcMeter {
  /** One Anchor confirmTransaction began (countConfirmations). */
  webSocketConfirmation(): void;
  /** One request to Helius's REST API, by HTTP verb (heliusRestFetch). */
  heliusRest(verb: string): void;
  /**
   * The doorbell's running total of delivered transactions (Doorbell.deliveryCounts().accepted).
   * The meter keeps the difference since the last reading; a total that went down is a fresh count.
   */
  webhookEventsSeen(total: number): void;
  /** Zeroes the per-sweep counts. Called at the top of a sweep, by the sweep. */
  startSweep(): void;
  /** Freezes what the sweep asked for as the "last sweep" figures. Called once the sweep has ended. */
  endSweep(): void;
  report(now: number): RpcUsageStatus;
}

export interface RpcUsageOptions {
  readonly archivalCredits: ArchivalCredits;
  readonly archivalCreditsSource: "default" | "env";
  readonly budgetPerDay: number | null;
  readonly startedAt: number;
  /** Injected for tests. */
  readonly now?: () => number;
}

const ENDPOINT_SEPARATOR = "\u0000";
const roundTenth = (value: number): number => Math.round(value * 10) / 10;

export function createRpcUsage(options: RpcUsageOptions): RpcUsage {
  const now = options.now ?? (() => Date.now());
  const day = (): RollingCounts => createRollingCounts({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS, startedAt: options.startedAt });
  const methods = day();
  const lines = day();
  const endpoints = day();
  const rest = day();
  let http429 = 0;
  let answering: { readonly at: string; readonly since: number } | null = null;
  let eventsTotal: number | null = null;

  let sweepMethods: Map<string, number> | null = null;
  let sweepLines: Map<string, number> | null = null;
  let lastSweep: { readonly calls: number; readonly byMethod: Record<string, number>; readonly credits: number } | null = null;

  const bump = (map: Map<string, number> | null, key: string, n = 1): void => {
    if (map !== null) map.set(key, (map.get(key) ?? 0) + n);
  };
  const line = (which: CreditClass, n = 1): void => {
    lines.add(which, n, now());
    bump(sweepLines, which, n);
  };
  /** NEVER THROWS INTO A CALLER: every entry point below runs inside it. */
  const quietly = (count: () => void): void => {
    try {
      count();
    } catch {
      // A lost count is a gap on a status page; a thrown one could be a lost settle.
    }
  };

  return {
    request(body) {
      quietly(() => {
        const at = now();
        for (const call of jsonRpcCalls(body)) {
          methods.add(call.method, 1, at);
          bump(sweepMethods, call.method);
          line(creditClassOf(call.method, call.params));
        }
      });
    },
    attempt(at, result) {
      quietly(() => {
        const kind = result === "unreachable" ? "unreachable" : result >= 200 && result < 300 ? "answered" : result === 429 ? "http429" : "httpOther";
        endpoints.add(`${at}${ENDPOINT_SEPARATOR}${kind}`, 1, now());
        if (kind === "http429") http429 += 1;
        if (kind === "answered" && answering?.at !== at) answering = { at, since: now() };
      });
    },
    webSocketConfirmation() {
      quietly(() => line("webSocketConfirmation"));
    },
    heliusRest(verb) {
      quietly(() => {
        const name = /^[A-Z]{3,7}$/.test(verb) ? verb : "OTHER";
        rest.add(name, 1, now());
        line(name === "POST" || name === "PUT" || name === "DELETE" ? "webhookWrite" : "webhookUnpriced");
      });
    },
    webhookEventsSeen(total) {
      quietly(() => {
        if (!Number.isFinite(total) || total < 0) return;
        const since = eventsTotal === null ? total : total >= eventsTotal ? total - eventsTotal : total;
        eventsTotal = total;
        if (since > 0) line("webhookEvent", since);
      });
    },
    startSweep() {
      sweepMethods = new Map();
      sweepLines = new Map();
    },
    endSweep() {
      quietly(() => {
        if (sweepMethods === null || sweepLines === null) return;
        const byMethod = Object.fromEntries([...sweepMethods].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        const calls = [...sweepMethods.values()].reduce((sum, n) => sum + n, 0);
        lastSweep = { calls, byMethod, credits: creditsFor(Object.fromEntries(sweepLines), options.archivalCredits) };
        sweepMethods = null;
        sweepLines = null;
      });
    },
    report(at) {
      const observedMs = methods.observedMs(at);
      const byLine = lines.totals(at);
      const estimate = (price: ArchivalCredits): number | null => {
        if (observedMs < MIN_OBSERVED_FOR_ESTIMATE_MS) return null;
        const scaled = scaledToWindow(creditsFor(byLine, price), observedMs, DAY_MS);
        return scaled === null ? null : Math.round(scaled);
      };
      const configured = estimate(options.archivalCredits);
      const byEndpointPerDay: Record<string, EndpointDay> = {};
      for (const [key, n] of Object.entries(endpoints.totals(at))) {
        const [label, kind] = key.split(ENDPOINT_SEPARATOR) as [string, keyof EndpointDay | undefined];
        const row = (byEndpointPerDay[label] ??= { answered: 0, http429: 0, httpOther: 0, unreachable: 0 });
        if (kind !== undefined && kind in row) (row as Record<keyof EndpointDay, number>)[kind] += n;
      }
      return {
        archivalCredits: options.archivalCredits,
        archivalCreditsSource: options.archivalCreditsSource,
        callsLastSweep: lastSweep?.calls ?? null,
        byMethodLastSweep: lastSweep?.byMethod ?? null,
        creditsLastSweep: lastSweep?.credits ?? null,
        observedMs,
        callsPerDay: methods.total(at),
        byMethodPerDay: methods.totals(at),
        byCreditClassPerDay: byLine,
        webSocketConfirmationsPerDay: byLine["webSocketConfirmation"] ?? 0,
        heliusRestPerDay: rest.totals(at),
        webhookEventsPerDay: byLine["webhookEvent"] ?? 0,
        creditsObserved: creditsFor(byLine, options.archivalCredits),
        creditsPerDayEstimate: configured,
        creditsPerDayEstimateP1: estimate(1),
        creditsPerDayEstimateP2: estimate(10),
        budgetPerDay: options.budgetPerDay,
        projectedMonthPct: configured === null || options.budgetPerDay === null ? null : roundTenth((configured / options.budgetPerDay) * 100),
        http429,
        http429PerDay: Object.values(byEndpointPerDay).reduce((sum, row) => sum + row.http429, 0),
        byEndpointPerDay,
        endpointSinceMs: answering === null ? null : Math.max(0, at - answering.since),
      };
    },
  };
}

/**
 * A `fetch` for the Helius webhook client (helius-webhooks.ts) that counts each
 * request by its HTTP verb and then makes it, unchanged.
 *
 * THE VERB AND NOTHING ELSE: the URL carries the API key in its query, so it is
 * neither read nor kept. Whatever the inner fetch answers or throws reaches the
 * client exactly as it would have without this. Without `inner` it calls
 * globalThis.fetch at the request, which is what the client's own default does.
 */
export function heliusRestFetch(
  usage: Pick<RpcUsage, "heliusRest">,
  inner: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    try {
      const verb = init?.method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET");
      usage.heliusRest(String(verb).toUpperCase());
    } catch {
      // Counted or not, the request goes.
    }
    return inner(input, init);
  }) as typeof fetch;
}

/** The one method of a Connection countConfirmations wraps. */
export interface ConfirmingConnection {
  confirmTransaction: (...args: never[]) => Promise<unknown>;
}

/**
 * Counts and times every confirmTransaction this Connection makes, by
 * replacing that one method ON THIS INSTANCE with a wrapper that calls the
 * original and hands back exactly what it returns or throws.
 *
 * WHY THIS ONE METHOD. Anchor's sendAndConfirm — every invest send, through
 * `.rpc()` and provider.sendAndConfirm (invest-tick.ts) — confirms with
 * connection.confirmTransaction, which listens on a websocket web3.js derives
 * from the endpoint, outside the pool — the uncounted websocket of the ADR's
 * prework table (§3.14 P4, citing disp-measure/static/expected.md §3.2).
 * web3.js closes that socket 500 ms after its last subscription ends, so a
 * confirmation every few minutes opens one each time. The settle path does not use it: it polls
 * getSignatureStatuses through the pool (settle-tick.ts, landing), which the
 * pool already counts. So this is the keeper's only traffic the pool cannot
 * see, and the only send whose time the settle's own report does not carry.
 *
 * NOTHING ELSE CHANGES: the same arguments go to the same method with the same
 * `this`, and the counting runs around it in a try of its own.
 */
export function countConfirmations(
  connection: ConfirmingConnection,
  report: { readonly started: () => void; readonly ended: (ms: number) => void },
  clock: () => number = () => Date.now(),
): void {
  const original = connection.confirmTransaction.bind(connection) as (...args: unknown[]) => Promise<unknown>;
  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    let at: number | null = null;
    try {
      at = clock();
      report.started();
    } catch {
      // Counted or not, the confirmation runs.
    }
    try {
      return await original(...args);
    } finally {
      try {
        if (at !== null) report.ended(clock() - at);
      } catch {
        // Timed or not, its answer is returned as it came.
      }
    }
  };
  connection.confirmTransaction = wrapped as ConfirmingConnection["confirmTransaction"];
}

/** The alerter's key for a keeper burning through its share of the Helius budget. */
export const CREDIT_BURN_ALERT_KEY = "credit-burn";

/** The share of the daily budget at which credit-burn warns: 80 % ([ROLLOUT] §6 row 2). */
export const CREDIT_BURN_WARN_FRACTION = 0.8;

/**
 * How much of the day must have been observed before the estimate may alert:
 * an hour.
 *
 * THE FIRST HOUR AFTER A DEPLOY IS NOT A DAY. Its first sweep is a full pass —
 * the doorbell is untrusted until its first event — and an estimate scaled up
 * from ten minutes of that would page for a burn that is mostly a restart.
 * Pushes restart the keepers often, so a rule that waited for a whole day would
 * rarely get to speak at all; an hour is sixty sweeps at the default cadence.
 */
export const CREDIT_BURN_MIN_OBSERVED_MS = 60 * 60 * 1_000;

/**
 * Whether this keeper's credit burn should be raised or cleared, from /status's
 * own `rpc` block. Raise at 80 % of SIP_SOLANA_CREDIT_BUDGET_DAY, page at
 * 100 %, clear below 80 % (ADR §6.3).
 *
 * OFF UNTIL THE OWNER SETS A BUDGET: no budget, nothing is raised or cleared,
 * so a keeper deployed with this code behaves exactly as before.
 *
 * PER SERVICE, AND THAT IS ONLY HALF OF IT (ADR §2.4, RT-9). The 10M credits are
 * the whole Helius project's, the website's Live polling included, and neither
 * keeper can see the others. This is the early warning for one consumer; the
 * project-wide check is the owner's Admin API read.
 *
 * ONE KEY, TWO SEVERITIES. The alerter lets an escalation from warn to critical
 * through on the same key, so a burn that keeps rising pages without a clear
 * in between.
 *
 * WHILE THE ARCHIVAL PRICE IS UNSETTLED, THE DEARER READING. With
 * SIP_SOLANA_ARCHIVAL_CREDITS unset (archivalCreditsSource "default", E1 not
 * answered), the estimate compared is the larger of P1 and P2 — the rollout's
 * "10 until the Admin API answers", for this alert alone. /status keeps its
 * headline at the configured price (DEFAULT_ARCHIVAL_CREDITS says why). For
 * both of today's keepers together the two readings are about 69k and 147k a
 * day (ADR §2.1): a budget sized between them, set before E1 answers, would
 * otherwise stay quiet while the bill could be twice the cheaper reading. Once
 * the variable is set, the price it names is the one compared.
 */
export function creditBurnAlert(rpc: RpcUsageStatus): { readonly fire: Alert | null; readonly clear: boolean } {
  const budget = rpc.budgetPerDay;
  const unsettled = rpc.archivalCreditsSource === "default";
  const estimate =
    unsettled && rpc.creditsPerDayEstimate !== null
      ? Math.max(rpc.creditsPerDayEstimate, rpc.creditsPerDayEstimateP1 ?? 0, rpc.creditsPerDayEstimateP2 ?? 0)
      : rpc.creditsPerDayEstimate;
  if (budget === null || estimate === null || rpc.observedMs < CREDIT_BURN_MIN_OBSERVED_MS) return { fire: null, clear: false };
  if (estimate < budget * CREDIT_BURN_WARN_FRACTION) return { fire: null, clear: true };
  const critical = estimate >= budget;
  const hours = Math.round((rpc.observedMs / 3_600_000) * 10) / 10;
  const pct = Math.round((estimate / budget) * 1_000) / 10;
  const both =
    rpc.creditsPerDayEstimateP1 === null || rpc.creditsPerDayEstimateP2 === null
      ? ""
      : ` At archival = 1 it is ${rpc.creditsPerDayEstimateP1}/day, at archival = 10 ${rpc.creditsPerDayEstimateP2}/day ` +
        (unsettled
          ? "(the price is not settled — E1 not answered — so this alert compares the higher reading; set " +
            "SIP_SOLANA_ARCHIVAL_CREDITS once it is)."
          : `(this keeper prices archival at ${rpc.archivalCredits}, as configured).`);
  return {
    fire: {
      key: CREDIT_BURN_ALERT_KEY,
      severity: critical ? "critical" : "warn",
      title: critical ? "This keeper is spending more Helius credits than its daily budget" : "This keeper is close to its daily Helius credit budget",
      detail:
        `About ${estimate} credits a day against a budget of ${budget} (${pct} %), ` +
        `estimated from the last ${hours} h.${both} First check /status.doorbell.trusted and the webhook's failingSince ` +
        "(a deaf doorbell makes every sweep a full pass); then raise SIP_SOLANA_SWEEP_MS on this service " +
        "(120000–300000 cuts the burn 2–5×, and settles start up to that much later). The budget is this service's " +
        "share only: the project's 10M also feeds the other keeper and the website.",
      context: {
        creditsPerDayEstimate: estimate,
        budgetPerDay: budget,
        observedMs: rpc.observedMs,
        archivalCredits: rpc.archivalCredits,
      },
    },
    clear: false,
  };
}
