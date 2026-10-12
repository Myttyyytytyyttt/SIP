// WHAT A DISPATCHER WORKER READS BEYOND THE KEEPER'S OWN CONFIG (plan P3a Q3;
// ADR §3.9, §3.11, §6.1 rule 3). Every variable here is strict: unset is its
// default, and anything else that is not an exact accepted form REFUSES TO START.
//
//   SIP_SOLANA_DISPATCH     off | shadow | on. UNSET IS OFF, and a worker that is
//                           off does nothing at all: bin/worker.mts says so and
//                           exits 0 before it opens a connection. `shadow` runs
//                           every job keyless and dry, writing 'shadow' intents
//                           and sending nothing (plan P3a design detail 1);
//                           `on` sends, through the fence.
//   SIP_SOLANA_WORKER_SLOTS jobs one process runs at once: 1 to 8, default 2
//                           (ADR §3.11, "start 2").
//   SIP_SOLANA_WORKERS_MAX  r_max: the most worker processes the fleet may run.
//                           A worker that has heard no quota runs on the floor,
//                           (plan × 0.8 − the scheduler's 8) / r_max, so every
//                           worker the fleet may ever run fits the plan at once
//                           (src/rpc-quota.ts). 1 to 64, default 2.
//   SIP_SOLANA_PLAN_RPS     the Helius plan's requests a second: 1 to 10 000,
//                           default 50 (Developer, HELIUS_DEVELOPER_RPS).
//
// THE REST OF THE KEEPER'S CONFIG IS READ BY loadConfig (src/config.ts) AS FOR
// ANY KEEPER, with these four names taken out first so it does not call them
// misspellings. And then three refusals only a worker has (workerRefusals): a
// shadow worker holds no key, a worker that is `on` holds one, and every worker
// needs its database.

import type { KeeperConfig } from "./config.js";
import { HELIUS_DEVELOPER_RPS } from "./rpc-quota.js";

export const DISPATCH_MODES = ["off", "shadow", "on"] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];

/** The variables this file reads; loadConfig is handed the environment without them. */
export const WORKER_VARS = ["SIP_SOLANA_DISPATCH", "SIP_SOLANA_WORKER_SLOTS", "SIP_SOLANA_WORKERS_MAX", "SIP_SOLANA_PLAN_RPS"] as const;

export const DEFAULT_WORKER_SLOTS = 2;
export const MAX_WORKER_SLOTS = 8;
export const DEFAULT_WORKERS_MAX = 2;
export const MAX_WORKERS = 64;
export const MAX_PLAN_RPS = 10_000;

export interface WorkerSettings {
  readonly mode: DispatchMode;
  readonly slots: number;
  readonly workersMax: number;
  readonly planRps: number;
}

const trimmed = (value: string | undefined): string | undefined => {
  const out = value?.trim();
  return out === undefined || out === "" ? undefined : out;
};

/** A whole number in [min, max] written as digits only, or null. */
function wholeIn(raw: string, min: number, max: number): number | null {
  if (!/^[0-9]{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** SIP_SOLANA_DISPATCH, strictly: unset or empty is `off`. */
export function readDispatchMode(raw: string | undefined): { readonly mode: DispatchMode } | { readonly problem: string } {
  const value = trimmed(raw);
  if (value === undefined) return { mode: "off" };
  if ((DISPATCH_MODES as readonly string[]).includes(value)) return { mode: value as DispatchMode };
  return {
    problem:
      `SIP_SOLANA_DISPATCH must be one of ${DISPATCH_MODES.join(", ")} (unset is off); it holds a ${value.length}-character value ` +
      "that is none of them, and a dispatcher mode that is guessed at is one that sends when nobody meant it to.",
  };
}

/** Every worker variable, strictly. */
export function readWorkerSettings(env: NodeJS.ProcessEnv): { readonly settings: WorkerSettings } | { readonly problems: readonly string[] } {
  const problems: string[] = [];
  const mode = readDispatchMode(env["SIP_SOLANA_DISPATCH"]);
  if ("problem" in mode) problems.push(mode.problem);
  const read = (name: (typeof WORKER_VARS)[number], fallback: number, min: number, max: number): number => {
    const raw = trimmed(env[name]);
    if (raw === undefined) return fallback;
    const value = wholeIn(raw, min, max);
    if (value === null) problems.push(`${name} must be a whole number from ${min} to ${max}, digits only (unset is ${fallback}).`);
    return value ?? fallback;
  };
  const slots = read("SIP_SOLANA_WORKER_SLOTS", DEFAULT_WORKER_SLOTS, 1, MAX_WORKER_SLOTS);
  const workersMax = read("SIP_SOLANA_WORKERS_MAX", DEFAULT_WORKERS_MAX, 1, MAX_WORKERS);
  const planRps = read("SIP_SOLANA_PLAN_RPS", HELIUS_DEVELOPER_RPS, 1, MAX_PLAN_RPS);
  if (problems.length > 0 || "problem" in mode) return { problems };
  return { settings: { mode: mode.mode, slots, workersMax, planRps } };
}

/** The environment loadConfig is handed: the same, without the worker's own names. */
export function keeperEnvOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of WORKER_VARS) delete out[name];
  return out;
}

/**
 * What a worker refuses to start with, whatever loadConfig accepted:
 *   * SHADOW WITH A KEY. A shadow worker is a dry run, and a dry run holds no
 *     key ([ROLLOUT] L4): armed means the signing secrets were read, so the
 *     process could sign. Disarm it (SIP_SOLANA_BROADCAST) before shadowing.
 *   * ON WITHOUT ONE. A worker that is `on` and cannot sign would claim vaults
 *     and complete every one RETRY; it refuses instead, and says what is missing.
 *   * NO DATABASE. The lease, the fence and the gate are rows; without them a
 *     worker is not a worker.
 */
export function workerRefusals(config: Pick<KeeperConfig, "armed" | "databaseUrl">, settings: Pick<WorkerSettings, "mode">): string[] {
  const problems: string[] = [];
  if (config.databaseUrl === null) problems.push("DATABASE_URL is required for a dispatcher worker: its leases, fences and send intents are rows.");
  if (settings.mode === "shadow" && config.armed) {
    problems.push(
      "SIP_SOLANA_DISPATCH=shadow on an armed keeper: a shadow worker is keyless and sends nothing, and an armed config has read " +
        "the signing secrets. Unset SIP_SOLANA_BROADCAST (and the sentence) for the shadow, or use `on`.",
    );
  }
  if (settings.mode === "on" && !config.armed) {
    problems.push(
      "SIP_SOLANA_DISPATCH=on needs an armed keeper (SIP_SOLANA_BROADCAST=1 and the exact SIP_SOLANA_ALLOW_BROADCAST sentence): " +
        "a worker that cannot sign would only claim vaults and hand them back. Use `shadow` for a keyless run.",
    );
  }
  return problems;
}
