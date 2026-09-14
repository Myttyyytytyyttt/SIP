/**
 * THE CONFIGURATION ENTRY POINT: the pages, and the gate of the Solana route
 * handlers. Server-only, because it parses SIP_SOLANA_RPC_URLS (endpoint keys)
 * through @sip/solana-core/server. Why this is not in config.ts: see that file's
 * header.
 *
 * SIP IS SOLANA-ONLY. The core's loadSolanaServerSettings owns the SIP_SOLANA_*
 * settings and its refusals: Nuvem's Solana configuration (NUVEM_SOLANA_*), the
 * old program id and the keeper's secret names. What this file adds is about the
 * names the web itself used to read, or must never hold:
 *
 * - SIP_CHAIN is no longer read. Unset, blank or solana (trimmed, any case) is
 *   accepted silently, so a service that still carries SIP_CHAIN=solana boots.
 *   Any other value is a problem naming the variable and never its value.
 * - PRIVY_APP_SECRET and PRIVY_AUTHORIZATION_PRIVATE_KEY are refused by NAME, the
 *   way the core refuses the keeper's secrets: present counts, blank included,
 *   and the value is never read. The web never calls Privy's server API.
 * - The retired EVM names (NUVEM_RPC_URL, PRIVY_SIGNER_ID, the factory…) are NOT
 *   refused, because nothing reads them. The first time a process sees any of
 *   them non-blank it logs one warning listing their names, never a value.
 *
 * A refused name is a problem on the page (the setup checklist) and makes the
 * Solana routes answer 503 with no detail, exactly like incomplete settings.
 *
 * Every problem, refused or missing, is also named in the server's log, because
 * nothing else would show it there: the process does not restart and
 * /api/health stays 200. One line per process for a given set of names, and
 * names only.
 */
import "server-only";

import { loadSolanaServerSettings, type SolanaGate } from "@sip/solana-core/server";

import { readPrivyAppId, settingFrom, type ConfigProblem, type Env, type LoadOptions, type SolanaConfigLoad } from "./config";

/** The browser's Solana HTTP RPC. Always this app's own relay; there is deliberately no variable for it. */
export const SOLANA_RELAY_PATH = "/api/solana-rpc";

const SIGNER = "SIP_SOLANA_PRIVY_SIGNER_ID";
const POLICY = "SIP_SOLANA_PRIVY_POLICY_ID";

/**
 * Privy server credentials, each with the keeper's own name for it. The web holds
 * neither. Their NAMES are checked; their values are never read.
 */
const REFUSED_PRIVY_CREDENTIALS: Readonly<Record<string, string>> = {
  PRIVY_APP_SECRET: "SIP_SOLANA_PRIVY_APP_SECRET",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY",
};

/** The EVM seat, in every spelling the old loader accepted. The Solana seat is SIGNER and POLICY above. */
const RETIRED_SEAT_NAMES: readonly string[] = [
  "PRIVY_SIGNER_ID",
  "SIP_PRIVY_SIGNER_ID",
  "NEXT_PUBLIC_PRIVY_SIGNER_ID",
  "PRIVY_POLICY_ID",
  "SIP_PRIVY_POLICY_ID",
  "NEXT_PUBLIC_PRIVY_POLICY_ID",
];

/**
 * Every name the EVM web read, in every spelling. Nothing reads them now, so a
 * stale Railway variable must not take the site down: they are named once, not
 * refused.
 */
const RETIRED_EVM_NAMES: readonly string[] = [
  ...RETIRED_SEAT_NAMES,
  ...["NUVEM_RPC_URL", "SIP_RPC_URL", "RPC_URL", "RPC_URL_4663"],
  ...["NUVEM_PUBLIC_RPC_URL", "SIP_PUBLIC_RPC_URL", "NEXT_PUBLIC_RPC_URL", "NEXT_PUBLIC_RPC_URL_4663"],
  ...["NUVEM_EXPLORER_URL", "SIP_EXPLORER_URL", "NEXT_PUBLIC_EXPLORER_URL", "EXPLORER_URL_4663"],
  ...["NUVEM_CHAIN_ID", "SIP_CHAIN_ID", "NEXT_PUBLIC_CHAIN_ID", "CHAIN_ID"],
  ...["NUVEM_VAULT_FACTORY", "SIP_VAULT_FACTORY", "VAULT_FACTORY", "NEXT_PUBLIC_VAULT_FACTORY"],
  ...["NUVEM_SETTLEMENT_EXECUTOR", "SIP_SETTLEMENT_EXECUTOR", "NEXT_PUBLIC_SETTLEMENT_EXECUTOR", "EXECUTOR"],
  ...["NUVEM_WETH", "SIP_WETH", "NEXT_PUBLIC_WETH", "WETH"],
  ...["NUVEM_PAUSE_CONTROLLER", "SIP_PAUSE_CONTROLLER", "NEXT_PUBLIC_PAUSE_CONTROLLER", "PAUSE_CONTROLLER"],
  ...["NUVEM_ATTESTER_REGISTRY", "SIP_ATTESTER_REGISTRY", "NEXT_PUBLIC_ATTESTER_REGISTRY", "ATTESTER_REGISTRY"],
  ...["NUVEM_COHORT_ID", "SIP_COHORT_ID", "COHORT_ID"],
  ...["NUVEM_LOGS_FROM_BLOCK", "SIP_LOGS_FROM_BLOCK", "LOGS_FROM_BLOCK"],
  ...["NUVEM_DISABLE_RPC_PROXY", "SIP_DISABLE_RPC_PROXY"],
];

function trimmed(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? null : value;
}

/** What the web itself refuses in its environment, before the core's rules. Names only, never a value. */
function environmentProblems(env: Env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const names = Object.keys(env);

  // SIP_CHAIN IS READ ONLY TO TELL A STALE VALUE APART. Unset, blank or solana is
  // what a Solana deployment already carries, so it boots; anything else was
  // meant for a site that no longer exists. The value is compared, never repeated.
  const chain = env["SIP_CHAIN"];
  const normalized = typeof chain === "string" ? chain.trim().toLowerCase() : "";
  if (normalized !== "" && normalized !== "solana") {
    problems.push({
      variable: "SIP_CHAIN",
      message: "SIP_CHAIN is no longer read: SIP is Solana-only.",
      howToFix: "Remove the variable. Unset, blank or solana is accepted, so deleting it is always safe.",
    });
  }

  // BY NAME, LIKE THE KEEPER'S SECRETS: a blank value counts, and no value is read.
  for (const [name, keeperName] of Object.entries(REFUSED_PRIVY_CREDENTIALS)) {
    if (names.includes(name)) {
      problems.push({
        variable: name,
        message: `${name} is a Privy server credential. The web never calls Privy's server API and must not hold it; its value was not read.`,
        howToFix:
          `Remove ${name} from the web service's environment, even if it is blank: the check is by name. Rotate it ` +
          `if this environment was shared. The keeper's own copy is ${keeperName}, and it belongs only to the keeper.`,
      });
    }
  }

  return problems;
}

/**
 * THE LATCHES ARE THE PROCESS'S, NOT THIS MODULE'S. A production build compiles
 * this file into two server runtimes, one for the pages and one for the route
 * handlers, each with its own module registry, so a module-level flag warned
 * once in each. Both runtimes share the process's globalThis, and a registered
 * symbol is the same key in both.
 */
const RETIRED_NAMES_WARNED = Symbol.for("sip.web.config.retiredNamesWarned");
const PROBLEMS_LOGGED = Symbol.for("sip.web.config.problemsLogged");
const processWide = globalThis as unknown as Record<symbol, unknown>;

/**
 * ONE WARNING PER PROCESS, NAMES ONLY. The first time any retired EVM name holds
 * something non-blank, one line lists those names, sorted, so the operator can
 * delete them. A value is compared with blank and never kept, logged or returned.
 */
function warnRetiredNamesOnce(env: Env): void {
  if (processWide[RETIRED_NAMES_WARNED] === true) return;
  const names = RETIRED_EVM_NAMES.filter((name) => trimmed(env, name) !== null).sort();
  if (names.length === 0) return;
  processWide[RETIRED_NAMES_WARNED] = true;
  const seat = names.some((name) => RETIRED_SEAT_NAMES.includes(name));
  console.warn(
    JSON.stringify({
      event: "web.config.retired_names",
      names,
      message:
        "These variables are no longer read: SIP is Solana-only. Remove them." +
        (seat ? ` The Privy seat is now ${SIGNER} and ${POLICY}.` : ""),
    }),
  );
}

/**
 * THE OPERATOR'S LINE, NAMES ONLY. A problem restarts nothing and /api/health
 * stays 200, so without this line a broken service looks healthy with silent
 * logs. It lists the problems' variable names, sorted and once each, and sends
 * the operator to /wallets for what to fix. Only `variable` is taken from a
 * problem: its message and howToFix stay on the page, and no value is logged.
 *
 * The latch holds the last names written, so repeated requests and both server
 * runtimes write one line, and a different set of names (an edited .env under
 * next dev) writes another.
 */
function logProblemsOnce(problems: readonly ConfigProblem[]): void {
  const names = [...new Set(problems.map((problem) => problem.variable))].sort();
  if (names.length === 0) return;
  const signature = JSON.stringify(names);
  if (processWide[PROBLEMS_LOGGED] === signature) return;
  processWide[PROBLEMS_LOGGED] = signature;
  console.error(
    JSON.stringify({
      event: "web.config.problems",
      names,
      message: "These variables need fixing in this service's environment. The /wallets page lists what to fix.",
    }),
  );
}

/** The whole configuration, reporting every problem at once. */
export function loadConfig(env: Env = process.env, options: LoadOptions = {}): SolanaConfigLoad {
  warnRetiredNamesOnce(env);
  const needPrivyAppId = options.needPrivyAppId ?? true;
  const problems: ConfigProblem[] = environmentProblems(env);

  const privy = readPrivyAppId(env, needPrivyAppId, problems);

  // THE SEAT. Both or neither, and never the same id twice: an empty policy list
  // is FULL permission at Privy, so "signer set, policy missing" must not degrade
  // into an unconstrained signer, and at Privy the two ids look alike, so pasting
  // one into the other's variable is refused by name.
  const signer = trimmed(env, SIGNER);
  const policy = trimmed(env, POLICY);
  if (needPrivyAppId) {
    if ((signer === null) !== (policy === null)) {
      const present = signer !== null ? SIGNER : POLICY;
      const missing = signer !== null ? POLICY : SIGNER;
      problems.push({
        variable: present,
        message: `${present} is set but ${missing} is not — a seat needs both.`,
        howToFix:
          `Set ${SIGNER} to the solana-keeper's Privy signer id AND ${POLICY} to the Solana policy that bounds it, ` +
          "or unset both to run without seats.",
      });
    } else if (signer !== null && signer === policy) {
      problems.push({
        variable: POLICY,
        message: `${POLICY} holds the same value as ${SIGNER}. No id is both a signer and a policy.`,
        howToFix: `Copy the POLICY id (a chain_type solana policy) from the Privy dashboard into ${POLICY}.`,
      });
    }
  }

  const settings = loadSolanaServerSettings(env);
  if (!settings.ok) problems.push(...settings.problems);

  if (!settings.ok || problems.length > 0 || (privy === null && needPrivyAppId)) {
    logProblemsOnce(problems);
    return { ok: false, problems };
  }

  const origin = options.origin ?? null;
  return {
    ok: true,
    config: {
      // Empty only for callers that declared they do not need it.
      privyAppId: privy?.value ?? "",
      privyClientId: settingFrom(env, "privyClientId"),
      privySignerId: signer,
      privyPolicyId: policy,
      solanaRpcUrl: origin === null ? SOLANA_RELAY_PATH : `${origin.replace(/\/+$/, "")}${SOLANA_RELAY_PATH}`,
      solanaWsUrl: settings.settings.publicWsUrl,
      programId: settings.settings.programId,
      explorer: "solscan",
      solana: settings.settings,
    },
  };
}

/**
 * The per-request gate of /api/solana-rpc and /api/solana-tx. It needs the server
 * settings and a clean environment, and nothing browser-facing: a missing Privy
 * app id must not take the relay down. There is no off switch; a deployment that
 * should not relay leaves the settings incomplete and gets 503.
 *
 * AN INVALID GATE LOGS WHAT /wallets LISTS. The gate's own problems are a subset
 * of the page's (the page adds the Privy app id and the seat), so logging only
 * them would alternate with the page's line, one more line each time a route
 * request follows a page request. loadConfig collects the page's whole list and
 * logs it; the gate's answer does not depend on that list and stays invalid.
 */
export function solanaGate(env: Env = process.env): SolanaGate {
  warnRetiredNamesOnce(env);
  if (environmentProblems(env).length === 0) {
    const settings = loadSolanaServerSettings(env);
    if (settings.ok) return { kind: "ok", settings: settings.settings };
  }
  loadConfig(env);
  return { kind: "invalid" };
}
