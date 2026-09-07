// Does the configuration describe the deployment it points at?
//
// THIS EXISTS BECAUSE THE ANSWER WAS ONCE NO, FOR MONTHS, SILENTLY. The MAINNET
// constants in config.ts are only consulted when their environment variable is
// absent, and after a redeployment four of the five pointed at contracts from a
// superseded release. Every one was a plausible address, nothing compared them
// against anything, and it surfaced only when `attesterRegistry` — the field
// nobody had set — resolved to an old registry naming a different attester and
// settlement began deferring with ATTESTER_MISMATCH.
//
// `VaultFactory.configureProtocol` is ONE-SHOT, so the factory address alone
// determines the other four for the life of that factory. That makes this check
// cheap and total: one eth_call, and any disagreement is the configuration being
// wrong rather than the chain.
//
// IT REFUSES RATHER THAN CORRECTS. Silently substituting what the factory says
// would start a keeper against a deployment its operator did not choose — and
// the operator who set NUVEM_VAULT_FACTORY to a new address and left the rest
// stale wanted the new deployment, while the one who changed nothing wanted the
// old. Only they know which; the check names the conflict and stops.

import { parseAbi, type Address } from "viem";

import { MAINNET } from "./config.js";

/**
 * The factory getter, field for field.
 *
 * The order is the STRUCT's, not alphabetical and not the order this file's
 * checks run in: `VaultFactory.ProtocolConfiguration` is
 * `{weth, pauseController, attesterRegistry, settlementExecutor}`
 * (VaultFactory.sol:27-31), and a public struct variable's generated getter
 * returns its members in declaration order. Getting this wrong does not fail
 * loudly — it silently compares the pause controller against the attester
 * registry and reports two mismatches that are both the decoding.
 */
export const PROTOCOL_CONFIGURATION_ABI = parseAbi([
  "function protocolConfiguration() view returns (address weth, address pauseController, address attesterRegistry, address settlementExecutor)",
]);

export interface DeploymentExpectation {
  readonly factory: Address;
  readonly executor: Address;
  readonly pauseController: Address;
  readonly attesterRegistry: Address;
  readonly weth: Address;
}

export interface OnChainConfiguration {
  readonly weth: Address;
  readonly pauseController: Address;
  readonly attesterRegistry: Address;
  readonly settlementExecutor: Address;
}

export type DeploymentVerdict =
  | { readonly kind: "MATCHES" }
  /** Named field by field, because "config is wrong" is not actionable. */
  | { readonly kind: "MISMATCH"; readonly problems: readonly string[] }
  /** The factory could not be read at all. Different from disagreeing. */
  | { readonly kind: "UNREADABLE"; readonly detail: string };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Compares what the operator configured against what the factory reports.
 *
 * Pure, so the whole matrix is testable without an RPC; the caller does the
 * eth_call. Every mismatch is reported, not just the first — an operator who
 * fixes one address and restarts into the next failure learns nothing about the
 * shape of the problem.
 */
export function verifyDeployment(
  expected: DeploymentExpectation,
  onChain: OnChainConfiguration,
): DeploymentVerdict {
  const problems: string[] = [];

  const check = (label: string, envVar: string, configured: Address, actual: Address): void => {
    if (!same(configured, actual)) {
      problems.push(
        `${label}: configured ${configured}, but factory ${expected.factory} reports ${actual}. ` +
          `Set ${envVar}=${actual}, or point NUVEM_VAULT_FACTORY at the deployment you meant.`,
      );
    }
  };

  check("settlement executor", "NUVEM_SETTLEMENT_EXECUTOR", expected.executor, onChain.settlementExecutor);
  check("pause controller", "NUVEM_PAUSE_CONTROLLER", expected.pauseController, onChain.pauseController);
  check("attester registry", "NUVEM_ATTESTER_REGISTRY", expected.attesterRegistry, onChain.attesterRegistry);
  check("WETH", "NUVEM_WETH", expected.weth, onChain.weth);

  return problems.length === 0 ? { kind: "MATCHES" } : { kind: "MISMATCH", problems };
}

/**
 * The five addresses the keeper will actually run with, resolved from the
 * environment the way `loadConfig` resolves them.
 *
 * IT MIRRORS `loadConfig`, IT DOES NOT APPROXIMATE IT. The entire value of this
 * check is that it verifies what the keeper WILL use, so the fallback rule has
 * to be identical — including that a variable set to the empty string counts as
 * absent and falls through to the constant. That is not a hypothetical: a
 * dashboard that clears a field usually writes "", and `config.ts:211-217`
 * treats it as unset, so a check that treated it as an address would pass while
 * the keeper ran on the stale constant.
 */
export function resolveExpectation(env: NodeJS.ProcessEnv, factory: Address): DeploymentExpectation {
  const pick = (name: string, fallback: string): Address => {
    const value = env[name];
    return (value !== undefined && value.trim() !== "" ? value.trim() : fallback) as Address;
  };
  return {
    factory,
    executor: pick("NUVEM_SETTLEMENT_EXECUTOR", MAINNET.executor),
    pauseController: pick("NUVEM_PAUSE_CONTROLLER", MAINNET.pauseController),
    attesterRegistry: pick("NUVEM_ATTESTER_REGISTRY", MAINNET.attesterRegistry),
    weth: pick("NUVEM_WETH", MAINNET.weth),
  };
}

/** One block an operator can act on, for a failed verdict. */
export function describeVerdict(verdict: DeploymentVerdict, factory: Address): string {
  if (verdict.kind === "MATCHES") return `deployment verified against factory ${factory}`;
  if (verdict.kind === "UNREADABLE") {
    return (
      `Could not read protocolConfiguration() from ${factory}: ${verdict.detail}\n` +
      "Either the factory address is wrong for this chain, or the RPC cannot reach it. " +
      "Refusing to start rather than settling against a deployment nobody has verified."
    );
  }
  return [
    `The configuration does not describe the factory it points at (${factory}).`,
    "",
    ...verdict.problems.map((p) => `  - ${p}`),
    "",
    "This is the failure mode that once deferred every settlement with ATTESTER_MISMATCH:",
    "the MAINNET constants in config.ts are only used when their variable is unset, so a",
    "redeployment leaves the unset ones pointing at the previous release. Nothing is",
    "corrected automatically — only you know which deployment you meant.",
  ].join("\n");
}
