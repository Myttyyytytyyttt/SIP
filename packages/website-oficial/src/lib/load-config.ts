/**
 * THE CONFIGURATION ENTRY POINT FOR CALLERS THAT DO NOT KNOW THE CHAIN YET: the
 * pages, and the gate of the Solana route handlers. Server-only, because the
 * Solana half parses SIP_SOLANA_RPC_URLS (endpoint keys) through
 * @sip/solana-core/server. Why this is not in config.ts: see that file's header.
 *
 * SIP_CHAIN picks the loader, and nothing crosses between them. Under solana the
 * EVM variables (NUVEM_RPC_URL, NUVEM_CHAIN_ID, the factory…) are IGNORED, not
 * refused, so a Railway service flips back to evm with a restart and no variable
 * deleted. What IS refused under solana is Nuvem's Solana configuration
 * (NUVEM_SOLANA_*), the old program id and the keeper's secret names; the core's
 * loadSolanaServerSettings owns those rules.
 */
import "server-only";

import { loadSolanaServerSettings, type SolanaGate } from "@sip/solana-core/server";

import {
  chainFrom,
  loadEvmConfig,
  readPrivyAppId,
  settingFrom,
  type AnyConfigLoad,
  type ConfigProblem,
  type Env,
  type LoadOptions,
  type SolanaConfigLoad,
} from "./config";

/** The browser's Solana HTTP RPC. Always this app's own relay; there is deliberately no variable for it. */
export const SOLANA_RELAY_PATH = "/api/solana-rpc";

const SIGNER = "SIP_SOLANA_PRIVY_SIGNER_ID";
const POLICY = "SIP_SOLANA_PRIVY_POLICY_ID";

function trimmed(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? null : value;
}

/** The whole configuration for whichever chain SIP_CHAIN names, reporting every problem at once. */
export function loadConfig(env: Env = process.env, options: LoadOptions = {}): AnyConfigLoad {
  const chain = chainFrom(env);
  if (!chain.ok) return { ok: false, problems: [chain.problem] };
  return chain.chain === "solana" ? loadSolanaConfig(env, options) : loadEvmConfig(env, options);
}

/** SIP_CHAIN=solana. Callers that already know the chain may call it directly. */
export function loadSolanaConfig(env: Env = process.env, options: LoadOptions = {}): SolanaConfigLoad {
  const needPrivyAppId = options.needPrivyAppId ?? true;
  const problems: ConfigProblem[] = [];

  // The same rule, and the same messages, as the EVM loader: Privy's length check is Privy's, not the chain's.
  const privy = readPrivyAppId(env, needPrivyAppId, problems);

  // THE SEAT, OVER THE SOLANA NAMES. Both or neither, and never the same id twice,
  // for the reasons config.ts gives for PRIVY_SIGNER_ID/PRIVY_POLICY_ID: an empty
  // policy list is FULL permission at Privy, and the two ids look alike. The EVM
  // pair is not read here; an EVM policy cannot bound a Solana wallet.
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
    return { ok: false, problems };
  }

  const origin = options.origin ?? null;
  return {
    ok: true,
    config: {
      chain: "solana",
      // Empty only for callers that declared they do not need it, exactly as on EVM.
      privyAppId: privy?.value ?? "",
      privyClientId: settingFrom(env, "privyClientId"),
      privySignerId: signer,
      privyPolicyId: policy,
      solanaRpcUrl: origin === null ? SOLANA_RELAY_PATH : `${origin.replace(/\/+$/, "")}${SOLANA_RELAY_PATH}`,
      solanaWsUrl: settings.settings.publicWsUrl,
      programId: settings.settings.programId,
      explorer: "solscan",
      solana: settings.settings,
      databaseUrl: settingFrom(env, "databaseUrl"),
    },
  };
}

/**
 * The per-request gate of /api/solana-rpc and /api/solana-tx. It needs only the
 * server settings: a missing Privy app id must not take the relay down, the same
 * coupling rule the EVM routes follow with needPrivyAppId:false.
 */
export function solanaGate(env: Env = process.env): SolanaGate {
  const chain = chainFrom(env);
  if (!chain.ok || chain.chain !== "solana") return { kind: "disabled" };
  const settings = loadSolanaServerSettings(env);
  return settings.ok ? { kind: "ok", settings: settings.settings } : { kind: "invalid" };
}
