// WHAT A DISPATCHER WORKER READS BEYOND THE KEEPER'S OWN CONFIG (plan P3a Q3;
// ADR §3.9, §3.11, §6.1 rule 3). Every variable here is strict: unset is its
// default, and anything else that is not an exact accepted form REFUSES TO START.
//
//   SIP_SOLANA_DISPATCH     off | shadow | on. UNSET IS OFF, and a worker that is
//                           off does nothing at all: bin/worker.mts says so and
//                           exits 0 before it opens a connection. Behind its
//                           health gate (below) `off` must be written out, and
//                           then the worker stays up answering /health, opening
//                           nothing. `shadow` runs every job keyless and dry,
//                           writing 'shadow' intents and sending nothing (plan
//                           P3a design detail 1); `on` sends, through the fence.
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
// AND THE PER-TRADE MODES (ADR §5, §6.2 M4–M6; plan §3.4, §7 row 14), all four
// strict, all four off when unset — and an unset SIP_SOLANA_EXTRA_MODES is TODAY:
// no per-trade byte has a module (src/settle-modules.ts), and such a vault's
// links rest at UNSUPPORTED_MODE before any RPC call.
//   SIP_SOLANA_EXTRA_MODES            roundup, fixed or both (comma-separated):
//                                     the per-trade modes this worker settles.
//   SIP_SOLANA_EXTRA_MODES_VAULTS     REQUIRED with it: the vault addresses it
//                                     settles them for, comma-separated, or `*`.
//                                     Who acts on a vault at all is still
//                                     vault_work.system's; this list is the
//                                     module's allowlist (plan §7 row 14).
//   SIP_SOLANA_EXTRA_MODES_LIVE       0 (unset) or 1. At 0 a live worker turns a
//                                     per-trade vault DRY: measured, reported,
//                                     never gated or sent (M4). 1 sends (M5).
//   SIP_SOLANA_EXTRA_MODES_FROM_SLOT  trades at or below this slot are forgiven
//                                     (RT-7): the slot serving widened at.
//                                     REQUIRED for LIVE=1, so the first live
//                                     window starts fresh.
//
// AND ITS DEPLOY GATE (src/worker-health.ts), OPT-IN:
//   SIP_SOLANA_WORKER_HEALTH  on or off; unset or empty is off. OFF SERVES
//                             NOTHING, WHATEVER PORT HOLDS: the image bakes
//                             PORT=8080 (Dockerfile) and Railway injects its
//                             own, so PORT is set on every worker and cannot say
//                             whether its service waits for a healthcheck. `on`
//                             answers GET /health on PORT (readWorkerHealth says
//                             what it refuses). With it, SIP_SOLANA_DISPATCH=off
//                             written out is a worker that answers 200 'off' and
//                             does nothing else: the stop that survives pushes.
//                             And with it a worker refuses three settings that
//                             without it only warn, or say nothing (G1–G3,
//                             workerRefusals).
//
// THE REST OF THE KEEPER'S CONFIG IS READ BY loadConfig (src/config.ts) AS FOR
// ANY KEEPER, with this file's names (WORKER_VARS) taken out first so it does
// not call them misspellings. And then the refusals only a worker has
// (workerRefusals): a shadow worker holds no key, a worker that is `on` holds
// one and names its Privy seat and policy, and every worker needs its database;
// behind its health gate, G1–G3 besides.

import { PublicKey } from "@solana/web3.js";
import { readPort, type KeeperConfig } from "./config.js";
import { DISPATCH_MODES, readDispatchMode, type DispatchMode } from "./cuts.js";
import { HELIUS_DEVELOPER_RPS, MIN_PLAN_RPS } from "./rpc-quota.js";

/**
 * SIP_SOLANA_DISPATCH has ONE READER, src/cuts.ts's, for the legacy keepers, the
 * scheduler and the workers alike: the processes of one fleet can never disagree
 * about what a value means. Re-exported for this file's callers.
 */
export { DISPATCH_MODES, readDispatchMode, type DispatchMode };

/** The per-trade modes' four variables (readExtraModes). */
export const EXTRA_MODES_VARS = ["SIP_SOLANA_EXTRA_MODES", "SIP_SOLANA_EXTRA_MODES_VAULTS", "SIP_SOLANA_EXTRA_MODES_LIVE", "SIP_SOLANA_EXTRA_MODES_FROM_SLOT"] as const;

/** The variables this file reads; loadConfig is handed the environment without them. PORT is not one: loadConfig reads it too, by the same rule (readPort). */
export const WORKER_VARS = ["SIP_SOLANA_DISPATCH", "SIP_SOLANA_WORKER_SLOTS", "SIP_SOLANA_WORKERS_MAX", "SIP_SOLANA_PLAN_RPS", "SIP_SOLANA_WORKER_HEALTH", ...EXTRA_MODES_VARS] as const;

/** SIP_SOLANA_EXTRA_MODES's names, and the skim_mode byte each serves. */
export const EXTRA_MODE_NAMES: Readonly<Record<string, number>> = Object.freeze({ roundup: 2, fixed: 3 });

/** What a worker serves of the per-trade modes; null is none (every variable unset). */
export interface ExtraModesSettings {
  readonly modes: ReadonlySet<number>;
  readonly vaults: ReadonlySet<string> | "*";
  readonly live: boolean;
  readonly fromSlot: bigint | null;
}

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
  /** The per-trade modes this worker serves, or null: none (every SIP_SOLANA_EXTRA_MODES* unset). */
  readonly extraModes: ExtraModesSettings | null;
  /** Its deploy gate's port (src/worker-health.ts), or null: no gate, nothing listens (SIP_SOLANA_WORKER_HEALTH unset, empty or off). */
  readonly health: { readonly port: number } | null;
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * The four SIP_SOLANA_EXTRA_MODES* variables, strictly (the header says what each
 * is). Every value that is not an exact accepted form refuses to start, and so
 * does any of the other three set WITHOUT SIP_SOLANA_EXTRA_MODES: set alone, it
 * would do nothing, and a setting that silently does nothing is the misspelling
 * this file exists to catch.
 */
export function readExtraModes(env: NodeJS.ProcessEnv): { readonly extraModes: ExtraModesSettings | null } | { readonly problems: readonly string[] } {
  const problems: string[] = [];
  const raw = (name: (typeof EXTRA_MODES_VARS)[number]): string | undefined => trimmed(env[name]);
  const modesRaw = raw("SIP_SOLANA_EXTRA_MODES");
  if (modesRaw === undefined) {
    const stray = EXTRA_MODES_VARS.filter((name) => name !== "SIP_SOLANA_EXTRA_MODES" && raw(name) !== undefined);
    if (stray.length > 0) {
      return { problems: [`${stray.join(", ")} set without SIP_SOLANA_EXTRA_MODES: no per-trade mode is served, so it would do nothing. Unset it, or name the modes.`] };
    }
    return { extraModes: null };
  }
  const modes = new Set<number>();
  modesRaw.split(",").forEach((entry, index) => {
    const name = entry.trim();
    const byte = Object.hasOwn(EXTRA_MODE_NAMES, name) ? EXTRA_MODE_NAMES[name]! : undefined;
    if (byte === undefined) problems.push(`SIP_SOLANA_EXTRA_MODES entry #${index + 1} is not roundup or fixed; it holds a ${name.length}-character value.`);
    else if (modes.has(byte)) problems.push(`SIP_SOLANA_EXTRA_MODES entry #${index + 1} repeats a mode an earlier entry already names.`);
    else modes.add(byte);
  });
  let vaults: ReadonlySet<string> | "*" = new Set<string>();
  const vaultsRaw = raw("SIP_SOLANA_EXTRA_MODES_VAULTS");
  if (vaultsRaw === undefined) {
    problems.push("SIP_SOLANA_EXTRA_MODES_VAULTS is required with SIP_SOLANA_EXTRA_MODES: the vault addresses served, comma-separated, or * for every vault.");
  } else if (vaultsRaw === "*") {
    vaults = "*";
  } else {
    const listed = new Set<string>();
    vaultsRaw.split(",").forEach((entry, index) => {
      const address = entry.trim();
      let valid = false;
      try {
        valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && new PublicKey(address).toBase58() === address;
      } catch {
        valid = false;
      }
      if (!valid) problems.push(`SIP_SOLANA_EXTRA_MODES_VAULTS entry #${index + 1} is not a base58 vault address.`);
      else listed.add(address);
    });
    vaults = listed;
  }
  const liveRaw = raw("SIP_SOLANA_EXTRA_MODES_LIVE");
  let live = false;
  if (liveRaw === "1") live = true;
  else if (liveRaw !== undefined && liveRaw !== "0") problems.push("SIP_SOLANA_EXTRA_MODES_LIVE must be 0 or 1 (unset is 0).");
  const fromRaw = raw("SIP_SOLANA_EXTRA_MODES_FROM_SLOT");
  let fromSlot: bigint | null = null;
  if (fromRaw !== undefined) {
    if (!/^[0-9]{1,20}$/.test(fromRaw) || BigInt(fromRaw) > U64_MAX) problems.push("SIP_SOLANA_EXTRA_MODES_FROM_SLOT must be a slot: a whole number, digits only.");
    else fromSlot = BigInt(fromRaw);
  }
  if (live && fromSlot === null) {
    problems.push(
      "SIP_SOLANA_EXTRA_MODES_LIVE=1 needs SIP_SOLANA_EXTRA_MODES_FROM_SLOT: the slot serving widened at, so trades made before it are forgiven rather than charged at a later price (ADR RT-7).",
    );
  }
  if (problems.length > 0) return { problems };
  return { extraModes: { modes, vaults, live, fromSlot } };
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

/**
 * SIP_SOLANA_WORKER_HEALTH, strictly (the header says why it, and not PORT, is
 * the switch): unset, empty or exactly `off` is no gate; exactly `on` is a gate
 * on PORT, read by loadConfig's own rule (readPort, src/config.ts) because a
 * worker kept off never reaches loadConfig. Refused, by name and never by value:
 *   H1  any other value;
 *   H2  `on` without a valid PORT: a gate with no port to answer on;
 *   H3  `on` with SIP_SOLANA_DISPATCH unset or empty. readDispatchMode reads that
 *       as off (src/cuts.ts), and a gated worker that is off answers 200, so a
 *       variable lost in a Duplicate or an edit would deploy green and serve
 *       nothing. Only `off` written out is that stop (bin/worker.mts).
 */
export function readWorkerHealth(env: NodeJS.ProcessEnv): { readonly health: { readonly port: number } | null } | { readonly problems: readonly string[] } {
  const value = trimmed(env["SIP_SOLANA_WORKER_HEALTH"]);
  if (value === undefined || value === "off") return { health: null };
  if (value !== "on") return { problems: [`SIP_SOLANA_WORKER_HEALTH must be on or off (unset is off); it holds a ${value.length}-character value.`] };
  const problems: string[] = [];
  const portRead = readPort(env["PORT"]);
  const port = "port" in portRead ? portRead.port : null;
  if ("problem" in portRead) problems.push(`SIP_SOLANA_WORKER_HEALTH=on answers /health on PORT: ${portRead.problem}`);
  else if (port === null) problems.push("SIP_SOLANA_WORKER_HEALTH=on answers /health on PORT, and PORT is not set: the port the healthcheck calls, an integer from 1 to 65535.");
  if (trimmed(env["SIP_SOLANA_DISPATCH"]) === undefined) {
    problems.push(
      "SIP_SOLANA_WORKER_HEALTH=on with SIP_SOLANA_DISPATCH unset or empty: that reads as off, and a gated worker that is off passes its " +
        "healthcheck serving nothing. Set SIP_SOLANA_DISPATCH to shadow or on, or to off to keep this worker stopped on purpose.",
    );
  }
  if (port === null || problems.length > 0) return { problems };
  return { health: { port } };
}

/** Every worker variable, strictly. */
export function readWorkerSettings(env: NodeJS.ProcessEnv): { readonly settings: WorkerSettings } | { readonly problems: readonly string[] } {
  const problems: string[] = [];
  const mode = readDispatchMode(env["SIP_SOLANA_DISPATCH"]);
  if ("problem" in mode) problems.push(mode.problem);
  const read = (name: "SIP_SOLANA_WORKER_SLOTS" | "SIP_SOLANA_WORKERS_MAX" | "SIP_SOLANA_PLAN_RPS", fallback: number, min: number, max: number): number => {
    const raw = trimmed(env[name]);
    if (raw === undefined) return fallback;
    const value = wholeIn(raw, min, max);
    if (value === null) problems.push(`${name} must be a whole number from ${min} to ${max}, digits only (unset is ${fallback}).`);
    return value ?? fallback;
  };
  const slots = read("SIP_SOLANA_WORKER_SLOTS", DEFAULT_WORKER_SLOTS, 1, MAX_WORKER_SLOTS);
  const workersMax = read("SIP_SOLANA_WORKERS_MAX", DEFAULT_WORKERS_MAX, 1, MAX_WORKERS);
  // FROM MIN_PLAN_RPS, NOT 1: a smaller plan leaves a worker no share at all (rpc-quota.ts).
  const planRps = read("SIP_SOLANA_PLAN_RPS", HELIUS_DEVELOPER_RPS, MIN_PLAN_RPS, MAX_PLAN_RPS);
  const extra = readExtraModes(env);
  if ("problems" in extra) problems.push(...extra.problems);
  const health = readWorkerHealth(env);
  if ("problems" in health) problems.push(...health.problems);
  if (problems.length > 0 || "problem" in mode || "problems" in extra || "problems" in health) return { problems };
  return { settings: { mode: mode.mode, slots, workersMax, planRps, extraModes: extra.extraModes, health: health.health } };
}

/** The environment loadConfig is handed: the same, without the worker's own names. */
export function keeperEnvOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of WORKER_VARS) delete out[name];
  return out;
}

/** The jupiter-key cut's two settings (readJupiterKeySettings, src/jupiter-pacer.ts): G2 asks only whether either is set, and quotes neither. */
const JUPITER_KEY_VARS = ["SIP_SOLANA_JUPITER_API_KEY", "SIP_SOLANA_JUPITER_CALLS_PER_MINUTE"] as const;

/**
 * What a worker refuses to start with, whatever loadConfig accepted:
 *   * SHADOW WITH A KEY. A shadow worker is a dry run, and a dry run holds no
 *     key ([ROLLOUT] L4): armed means the signing secrets were read, so the
 *     process could sign. Disarm it (SIP_SOLANA_BROADCAST) before shadowing.
 *   * ON WITHOUT ONE. A worker that is `on` and cannot sign would claim vaults
 *     and complete every one RETRY; it refuses instead, and says what is missing.
 *   * NO DATABASE. The lease, the fence and the gate are rows; without them a
 *     worker is not a worker.
 *
 * AND BEHIND ITS HEALTH GATE (settings.health), three that elsewhere only warn
 * or say nothing. A gated deploy that starts replaces the worker before it, so
 * what it starts with is what serves. Without the gate none of the three is
 * asked: the worker starts as it did before the gate, and a keyless cut still
 * falls back to lite-api.jup.ag without a word.
 *   G1  `on`, the jupiter-key cut, and no SIP_SOLANA_JUPITER_API_KEY. The cut's
 *       reader answers no key and no problem (readJupiterKeySettings), and every
 *       quote goes keyless to lite-api.jup.ag, where a buy was refused on a 429
 *       nobody saw (2026-10-27). `on` ONLY: a shadow sends nothing, so a keyless
 *       shadow costs no buy; and a shadow is meant to run keyless
 *       (test-local/shadow/harness.ts starts its workers without a Jupiter key),
 *       because Jupiter counts the budget per organisation and a shadow on the
 *       production key would spend the live worker's minute on buys it never
 *       sends. Nothing refuses a shadow that carries the cut and its key
 *       (test/worker-health-boot.test.ts boots one).
 *   G2  SIP_SOLANA_JUPITER_API_KEY or SIP_SOLANA_JUPITER_CALLS_PER_MINUTE set
 *       without the cut, which loadConfig only warns is unused. A worker's
 *       refusal: the scheduler reads the rate as its own number, without the
 *       cut (src/scheduler-config.ts). Read from `env` by name and by whether it
 *       is empty, as readJupiterKeySettings reads them, and never quoted. So
 *       behind the gate the cut's rollback is the token with both settings:
 *       the token alone is a refused deploy, and the worker before it serves on.
 *   G3  `on` without SIP_SOLANA_ALERT_WEBHOOK, which bin/worker.mts only warns
 *       about: every page of a failed settle or buy would reach this log alone.
 */
export function workerRefusals(
  config: Pick<KeeperConfig, "armed" | "databaseUrl" | "cuts" | "jupiterApiKey" | "alertWebhook"> &
    Partial<Pick<KeeperConfig, "signing" | "privySignerId" | "privyPolicyId">>,
  settings: Pick<WorkerSettings, "mode" | "health">,
  env: NodeJS.ProcessEnv,
): string[] {
  const problems: string[] = [];
  if (config.databaseUrl === null) problems.push("DATABASE_URL is required for a dispatcher worker: its leases, fences and send intents are rows.");
  if (settings.mode === "shadow" && config.armed) {
    problems.push(
      "SIP_SOLANA_DISPATCH=shadow on an armed keeper: a shadow worker is keyless and sends nothing, and an armed config has read " +
        "the signing secrets. Unset SIP_SOLANA_BROADCAST (and the sentence) for the shadow, or use `on`.",
    );
  }
  // A LIVE WORKER SIGNING THROUGH PRIVY NAMES ITS SEAT AND ITS POLICY. Without
  // the signer id every Privy wallet resolves as signable, and without the policy
  // id a seat with no policy of its own is not told apart: the legacy keeper pages
  // that at boot (seatCheckNotice), because it had to start before the policy
  // existed; a worker refuses instead. Refused, it never answers /health
  // (src/worker-health.ts), so with the service's Healthcheck Path the deploy
  // fails and Railway keeps the worker before it running.
  if (settings.mode === "on" && config.signing?.privy != null) {
    const missing = [config.privySignerId == null ? "SIP_SOLANA_PRIVY_SIGNER_ID" : null, config.privyPolicyId == null ? "SIP_SOLANA_PRIVY_POLICY_ID" : null].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      problems.push(
        `SIP_SOLANA_DISPATCH=on signs through Privy without ${missing.join(" and ")}: the worker would sign for wallets whose seat it cannot check. ` +
          "Reference them from sip-solana-keeper, as the signing secrets.",
      );
    }
  }
  if (settings.mode === "on" && !config.armed) {
    problems.push(
      "SIP_SOLANA_DISPATCH=on needs an armed keeper (SIP_SOLANA_BROADCAST=1 and the exact SIP_SOLANA_ALLOW_BROADCAST sentence): " +
        "a worker that cannot sign would only claim vaults and hand them back. Use `shadow` for a keyless run.",
    );
  }
  if (settings.health === null) return problems;
  const cut = config.cuts.has("jupiter-key");
  if (settings.mode === "on" && cut && config.jupiterApiKey === null) {
    problems.push(
      "SIP_SOLANA_CUTS names jupiter-key without SIP_SOLANA_JUPITER_API_KEY: behind its health gate a worker that is `on` does not " +
        "buy keyless through lite-api.jup.ag, where a buy was refused on a 429 nobody saw (2026-10-27). Set " +
        "SIP_SOLANA_JUPITER_API_KEY on this service, or take jupiter-key out of SIP_SOLANA_CUTS.",
    );
  }
  const unused = JUPITER_KEY_VARS.filter((name) => trimmed(env[name]) !== undefined);
  if (!cut && unused.length > 0) {
    problems.push(
      `${unused.join(" and ")} set without jupiter-key in SIP_SOLANA_CUTS: not used — every Jupiter call goes keyless to ` +
        "lite-api.jup.ag, unpaced — and behind its health gate a worker refuses a setting that does nothing. Add jupiter-key " +
        `to SIP_SOLANA_CUTS, or unset ${unused.length === 1 ? "it" : "them"}.`,
    );
  }
  if (settings.mode === "on" && config.alertWebhook === null) {
    problems.push(
      "SIP_SOLANA_DISPATCH=on without SIP_SOLANA_ALERT_WEBHOOK: behind its health gate a worker that sends does not start with " +
        "nowhere to page — a failed settle or buy would reach only this service's log. Reference it from " +
        "sip-solana-keeper, as the signing secrets.",
    );
  }
  return problems;
}
