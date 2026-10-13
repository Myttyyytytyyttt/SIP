// The scheduler's environment (bin/scheduler.mts): what a `keeper-scheduler`
// service reads, and what it refuses to hold (dispatcher ADR §3.11's topology;
// plan §2 rule 1, §3.3.1).
//
// SIP_SOLANA_DISPATCH FIRST, AND OFF BY DEFAULT. `off` (or unset) and the entry
// point does nothing at all — it reads no other variable, opens no connection
// and exits 0 — so a scheduler service deployed before the owner says so is a
// process that ends. `shadow` and `on` run the scheduler; they differ only in
// what the scheduler is allowed to touch outside the database: in `shadow` it
// never manages a Helius webhook, whatever the fleet row says (a shadow fleet
// must never edit the production webhook), and the workers of a shadow fleet
// gate and never send (src/dispatch-store.ts). An unknown value refuses to
// start, by shape and never by value, as every SIP_SOLANA_* variable does.
//
// A SCHEDULER HOLDS NO KEY (ADR §3.11: "No settle key, no Privy key"). It is the
// replica on a public domain — /hooks/helius, /status, /leaderboard — and the
// whole point of splitting the services is that the internet-facing process
// cannot sign. So the arming pair, every signing secret and the Jupiter key
// REFUSE TO START when present, by NAME (Object.keys reads no value), and none
// of them is ever read. A legacy role is refused too: SIP_SOLANA_ROLE set on a
// scheduler is an environment copied from a keeper service.
//
// WHAT IT SHARES WITH THE LEGACY KEEPER is read by loadConfig itself (the RPC
// endpoints, the program id, the tick, DATABASE_URL, PORT, the alert webhook,
// the doorbell secret and the Helius key, the archival price), from a copy of
// the environment without the scheduler's own variables, so every rule
// config.ts enforces — the redactor, the 6543 refusal, Nuvem's names — holds
// here unchanged. DATABASE_URL is required: the scheduler is Postgres.
//
// ITS OWN NUMBERS, strict like every new variable (plan §2 rule 1), each with
// the default the ADR assumes:
//   * SIP_SOLANA_PLAN_RPS — the provider plan's requests a second (50,
//     Developer): the fleet gets 0.8 of it (src/rpc-quota.ts);
//   * SIP_SOLANA_WORKERS_MAX — r_max, the most worker replicas the fleet may
//     run (2): the floor every worker falls back to divides by it;
//   * SIP_SOLANA_PLAN_CREDITS_MONTH — the plan's credits a month (10M): the
//     credit governor's 90 % and 100 % (src/credit-governor.ts);
//   * SIP_SOLANA_JUPITER_CALLS_PER_MINUTE — the organisation's Jupiter minute
//     the hand-out divides among workers (30, keyless). Only the NUMBER: the key
//     is a worker's;
//   * SIP_SOLANA_PRICE_TAPE — off (unset) or on: whether the lock holder samples
//     Pyth's SOL/USD price into sip_solana.sol_price_tape once a tick, from the
//     tick's first request (src/price-tape.ts, ADR §5.2.3). The per-trade modes'
//     round-up prices from it; switched on before any per-trade vault is served,
//     so the tape holds history by the time one is (ADR §5.7 U1).
//
// SIP_SOLANA_CUTS ON A SCHEDULER names the scheduler's cuts: `gpa-v2` (C6, its
// listing) and `lamports-filter` (C7, its batch read). Every legacy token is
// accepted too, because the same list may be shared with the workers that act
// on them (plan design detail 4), and each one the scheduler does not act on is
// SAID, in a warning; `lamports-filter` is accepted ONLY here — the legacy
// keeper still refuses it, because there it would do nothing.

import { sharedRedactor, type Redactor } from "@sip/solana-log";
import { ConfigError, SIGNING_SECRET_VARS, loadConfig, shape, type KeeperConfig } from "./config.js";
import { CUT_TOKENS, DISPATCH_MODES, readDispatchMode, type DispatchMode } from "./cuts.js";
import { HELIUS_DEVELOPER_CREDITS_MONTH } from "./credit-governor.js";
import { JUPITER_MAX_CALLS_PER_MINUTE } from "./jupiter-pacer.js";
import { HELIUS_DEVELOPER_RPS } from "./rpc-quota.js";
import { JUPITER_KEYLESS_CALLS_PER_MINUTE } from "./sweep-cost.js";

/**
 * SIP_SOLANA_DISPATCH has ONE READER, src/cuts.ts's, for the legacy keepers, the
 * scheduler and the workers alike (re-exported here for bin/scheduler.mts): the
 * three processes of one fleet can never disagree about what a value means.
 */
export { DISPATCH_MODES, readDispatchMode };

/** The cuts a scheduler acts on. */
export const SCHEDULER_CUT_TOKENS = ["gpa-v2", "lamports-filter"] as const;
export type SchedulerCutToken = (typeof SCHEDULER_CUT_TOKENS)[number];

/** Every token a scheduler's SIP_SOLANA_CUTS may name: the legacy list, and C7. */
export const SCHEDULER_ACCEPTED_TOKENS: readonly string[] = [...CUT_TOKENS, "lamports-filter"];

/** The scheduler's own variables, which the legacy keeper does not read. */
export const SCHEDULER_VARS = ["SIP_SOLANA_DISPATCH", "SIP_SOLANA_PLAN_RPS", "SIP_SOLANA_WORKERS_MAX", "SIP_SOLANA_PLAN_CREDITS_MONTH", "SIP_SOLANA_PRICE_TAPE"] as const;

/** Present on a scheduler, these refuse to start: it holds no key and arms nothing. */
export const SCHEDULER_REFUSED_VARS = [
  "SIP_SOLANA_BROADCAST",
  "SIP_SOLANA_ALLOW_BROADCAST",
  ...SIGNING_SECRET_VARS,
  "SIP_SOLANA_JUPITER_API_KEY",
  "SIP_SOLANA_ROLE",
] as const;

/** A worker's or a legacy keeper's settings: present on a scheduler, they are not read, and a warning says so. */
export const SCHEDULER_IGNORED_VARS = [
  "SIP_SOLANA_POOLS",
  "SIP_SOLANA_CARRY_STORE",
  "SIP_SOLANA_DISCOVERY_LKG_MS",
  "SIP_SOLANA_PRIVY_APP_ID",
  "SIP_SOLANA_PRIVY_SIGNER_ID",
  "SIP_SOLANA_PRIVY_POLICY_ID",
] as const;

export const WORKERS_MAX_LIMIT = 64;
export const PLAN_RPS_LIMIT = 10_000;

export interface SchedulerConfig {
  readonly dispatch: Exclude<DispatchMode, "off">;
  /** What loadConfig read of the shared variables. Unarmed by construction: signing is null. */
  readonly base: KeeperConfig;
  readonly cuts: ReadonlySet<SchedulerCutToken>;
  /** Every token named, the scheduler's and the workers'. */
  readonly named: readonly string[];
  readonly planRps: number;
  readonly workersMax: number;
  readonly planCreditsPerMonth: number;
  readonly jupiterCallsPerMinute: number;
  /** SIP_SOLANA_PRICE_TAPE: whether the lock holder samples the per-trade price tape. Off when unset. */
  readonly priceTape: boolean;
  /** Already scrubbed. */
  readonly warnings: readonly string[];
}

/** SIP_SOLANA_PRICE_TAPE, strictly: unset or "off" is off, "on" is on, anything else refuses to start. */
export function readPriceTape(raw: string | undefined): { readonly on: boolean } | { readonly problem: string } {
  const value = raw?.trim();
  if (value === undefined || value === "" || value === "off") return { on: false };
  if (value === "on") return { on: true };
  return { problem: `SIP_SOLANA_PRICE_TAPE must be off or on (unset is off); it holds ${shape(value)}.` };
}

/** SIP_SOLANA_CUTS on a scheduler: readCuts's rules (src/cuts.ts) over the scheduler's accepted list. */
export function readSchedulerCuts(raw: string | undefined): { readonly named: readonly string[] } | { readonly problems: readonly string[] } {
  const value = raw?.trim();
  if (value === undefined || value === "") return { named: [] };
  const problems: string[] = [];
  const named: string[] = [];
  value.split(",").forEach((entry, index) => {
    const token = entry.trim();
    const position = index + 1;
    if (!SCHEDULER_ACCEPTED_TOKENS.includes(token)) {
      problems.push(
        `SIP_SOLANA_CUTS entry #${position} is not a cut this scheduler or its workers implement (${SCHEDULER_ACCEPTED_TOKENS.join(", ")}); ` +
          `it holds ${token === "" ? "an empty value" : `a ${token.length}-character value`}.`,
      );
      return;
    }
    if (named.includes(token)) {
      problems.push(`SIP_SOLANA_CUTS entry #${position} repeats a token an earlier entry already names.`);
      return;
    }
    named.push(token);
  });
  return problems.length > 0 ? { problems } : { named };
}

function readCount(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  limit: number,
  problems: string[],
  what: string,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > limit) {
    problems.push(`${name} must be a whole number from 1 to ${limit} (${what}); it holds ${shape(raw)}.`);
    return fallback;
  }
  return parsed;
}

/**
 * The scheduler's configuration, or a ConfigError naming every problem. Call
 * only once SIP_SOLANA_DISPATCH has been read as shadow or on (the entry point
 * reads it first and stops at off).
 */
export function loadSchedulerConfig(env: NodeJS.ProcessEnv, redactor: Redactor = sharedRedactor): SchedulerConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const names = Object.keys(env);

  const dispatchRead = readDispatchMode(env["SIP_SOLANA_DISPATCH"]);
  if ("problem" in dispatchRead) problems.push(dispatchRead.problem);
  const dispatch = "mode" in dispatchRead ? dispatchRead.mode : "off";
  if (dispatch === "off" && !("problem" in dispatchRead)) {
    problems.push("SIP_SOLANA_DISPATCH is off: the scheduler is not to run (this is the entry point's job to say before loading its configuration).");
  }

  // NAMES ONLY, NEVER VALUES: a key present on a public replica refuses the deploy.
  const refused = SCHEDULER_REFUSED_VARS.filter((name) => names.includes(name));
  if (refused.length > 0) {
    problems.push(
      `${refused.join(", ")}: set on a scheduler, which holds no key, arms nothing and is not a keeper role (dispatcher ADR §3.11). ` +
        "Delete them from this service; they belong to the workers (signing) or to a legacy keeper (the role).",
    );
  }
  const ignored = SCHEDULER_IGNORED_VARS.filter((name) => names.includes(name));
  if (ignored.length > 0) warnings.push(`${ignored.join(", ")}: a worker's or a legacy keeper's setting; the scheduler does not read it.`);

  const cutsRead = readSchedulerCuts(env["SIP_SOLANA_CUTS"]);
  const named = "named" in cutsRead ? cutsRead.named : [];
  if ("problems" in cutsRead) problems.push(...cutsRead.problems);
  const cuts = new Set(named.filter((token): token is SchedulerCutToken => (SCHEDULER_CUT_TOKENS as readonly string[]).includes(token)));
  const elsewhere = named.filter((token) => !(SCHEDULER_CUT_TOKENS as readonly string[]).includes(token) && token !== "watchdog-exit");
  if (elsewhere.length > 0) warnings.push(`SIP_SOLANA_CUTS names ${elsewhere.join(", ")}: a worker acts on ${elsewhere.length === 1 ? "it" : "them"}, the scheduler does not.`);

  const planRps = readCount(env, "SIP_SOLANA_PLAN_RPS", HELIUS_DEVELOPER_RPS, PLAN_RPS_LIMIT, problems, "the provider plan's requests a second");
  const workersMax = readCount(env, "SIP_SOLANA_WORKERS_MAX", 2, WORKERS_MAX_LIMIT, problems, "the most worker replicas the fleet runs");
  const planCreditsPerMonth = readCount(env, "SIP_SOLANA_PLAN_CREDITS_MONTH", HELIUS_DEVELOPER_CREDITS_MONTH, 10_000_000_000, problems, "the plan's credits a month");
  const tapeRead = readPriceTape(env["SIP_SOLANA_PRICE_TAPE"]);
  if ("problem" in tapeRead) problems.push(tapeRead.problem);
  const priceTape = "on" in tapeRead && tapeRead.on;
  const jupiterCallsPerMinute = readCount(
    env,
    "SIP_SOLANA_JUPITER_CALLS_PER_MINUTE",
    JUPITER_KEYLESS_CALLS_PER_MINUTE,
    JUPITER_MAX_CALLS_PER_MINUTE,
    problems,
    "the organisation's Jupiter calls a minute",
  );

  // THE SHARED VARIABLES, through loadConfig itself, without the scheduler's
  // own, the refused and the ignored (each said above), and without the cuts.
  const shared: NodeJS.ProcessEnv = {};
  const skip = new Set<string>([
    ...SCHEDULER_VARS,
    ...SCHEDULER_REFUSED_VARS,
    ...SCHEDULER_IGNORED_VARS,
    "SIP_SOLANA_CUTS",
    "SIP_SOLANA_JUPITER_CALLS_PER_MINUTE",
  ]);
  for (const name of names) if (!skip.has(name)) shared[name] = env[name];
  let base: KeeperConfig | null = null;
  try {
    base = loadConfig(shared, redactor);
    warnings.push(...base.warnings);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }
  if (base !== null && base.databaseUrl === null) {
    problems.push("DATABASE_URL is required: the scheduler keeps the whole queue in Postgres (a postgres:// URL on the session port, 5432).");
  }
  const scrub = (text: string): string => redactor.scrub(text);
  if (problems.length > 0 || base === null) throw new ConfigError(problems.map(scrub));
  return Object.freeze({
    dispatch: dispatch as Exclude<DispatchMode, "off">,
    base,
    cuts,
    named,
    planRps,
    workersMax,
    planCreditsPerMonth,
    jupiterCallsPerMinute,
    priceTape,
    warnings: Object.freeze(warnings.map(scrub)),
  });
}

/** Whether a token the scheduler acts on is named. */
export function schedulerCut(config: Pick<SchedulerConfig, "cuts">, token: SchedulerCutToken): boolean {
  return config.cuts.has(token);
}
