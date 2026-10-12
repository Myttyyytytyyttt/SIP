// The operator's command for the two-step handover (src/handover.ts): what it
// accepts and what each command does. bin/dispatch-handover.mts only connects
// the database and the chain; everything a person can type is decided here, and
// tested here without either.
//
//   status [vault]                 the vaults that are not legacy (or one), every legacy keeper's receipt, the new-vault flag
//   drain <vault>                  legacy → draining
//   arm <vault> | --all            draining → queue (run it again until it says moved)
//       [--roles=profit,volume]    the legacy roles that must have let go (default: every role);
//                                  `none` only for a database no legacy keeper uses (a shadow's)
//       [--allow-dry]              accept receipts from keepers that are not acting (a drill with no armed keeper)
//   rollback <vault>               queue → draining
//   release <vault>                draining → legacy
//   gone <process-id>... | --stale mark legacy processes whose containers no longer exist
//   new-vaults legacy|queue        fleet.new_vault_system
//
// A vault is a base58 address of 32 bytes; anything else is refused before the
// database is touched.

import { PublicKey } from "@solana/web3.js";
import type { NewVaultSystem } from "./dispatch-select.js";
import type { ChainHeights, Handover } from "./handover.js";
import { KEEPER_ROLES, isKeeperRole, type KeeperRole } from "./role-registry.js";

export type HandoverCommand =
  | { readonly kind: "status"; readonly vault: string | null }
  | { readonly kind: "drain" | "rollback" | "release"; readonly vault: string }
  | { readonly kind: "arm"; readonly vault: string | "all"; readonly requiredRoles: readonly KeeperRole[]; readonly allowDry: boolean }
  | { readonly kind: "gone"; readonly processIds: readonly string[] | "stale" }
  | { readonly kind: "new-vaults"; readonly system: NewVaultSystem };

export const HANDOVER_USAGE = [
  "dispatch-handover status [vault]",
  "dispatch-handover drain <vault>",
  "dispatch-handover arm <vault>|--all [--roles=profit,volume] [--allow-dry]",
  "dispatch-handover rollback <vault>",
  "dispatch-handover release <vault>",
  "dispatch-handover gone <process-id>...|--stale",
  "dispatch-handover new-vaults legacy|queue",
].join("\n");

function vaultArg(raw: string | undefined): string {
  if (raw === undefined) throw new Error("a vault address is required");
  let key: PublicKey;
  try {
    key = new PublicKey(raw);
  } catch {
    throw new Error(`not a vault address: a ${raw.length}-character value`);
  }
  if (key.toBase58() !== raw) throw new Error(`not a vault address in its base58 form: a ${raw.length}-character value`);
  return raw;
}

/** The command line, strictly: an unknown command, flag or extra argument refuses. */
export function parseHandoverArgs(argv: readonly string[]): HandoverCommand {
  const [command, ...rest] = argv;
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const args = rest.filter((arg) => !arg.startsWith("--"));
  const only = (allowed: readonly string[]): void => {
    const unknown = flags.filter((flag) => !allowed.includes(flag.split("=")[0]!));
    if (unknown.length > 0) throw new Error(`unknown flag for ${command}: ${unknown.join(", ")}`);
  };
  const atMost = (count: number): void => {
    if (args.length > count) throw new Error(`${command} takes at most ${count} argument${count === 1 ? "" : "s"}`);
  };
  switch (command) {
    case "status":
      only([]);
      atMost(1);
      return { kind: "status", vault: args[0] === undefined ? null : vaultArg(args[0]) };
    case "drain":
    case "rollback":
    case "release":
      only([]);
      atMost(1);
      return { kind: command, vault: vaultArg(args[0]) };
    case "arm": {
      only(["--all", "--roles", "--allow-dry"]);
      atMost(1);
      const all = flags.includes("--all");
      if (all === (args.length === 1)) throw new Error("arm takes one vault, or --all");
      const rolesFlag = flags.find((flag) => flag.startsWith("--roles"));
      let requiredRoles: readonly KeeperRole[] = KEEPER_ROLES;
      if (rolesFlag !== undefined) {
        const value = rolesFlag.startsWith("--roles=") ? rolesFlag.slice("--roles=".length) : "";
        // `none`, SPELLED OUT: no role's receipt is required, which is right only
        // for a database no legacy keeper uses. Every receipt that IS there still
        // has to name the vault.
        const roles = value === "none" ? [] : value.split(",").map((role) => role.trim());
        if ((value !== "none" && roles.some((role) => !isKeeperRole(role))) || new Set(roles).size !== roles.length) {
          throw new Error(`--roles= takes a comma-separated list of ${KEEPER_ROLES.join(", ")}, each once, or none`);
        }
        requiredRoles = roles as KeeperRole[];
      }
      return { kind: "arm", vault: all ? "all" : vaultArg(args[0]), requiredRoles, allowDry: flags.includes("--allow-dry") };
    }
    case "gone":
      only(["--stale"]);
      if (flags.includes("--stale")) {
        if (args.length > 0) throw new Error("gone takes process ids, or --stale, not both");
        return { kind: "gone", processIds: "stale" };
      }
      if (args.length === 0) throw new Error("gone takes one or more process ids (from status), or --stale");
      return { kind: "gone", processIds: args };
    case "new-vaults":
      only([]);
      atMost(1);
      if (args[0] !== "legacy" && args[0] !== "queue") throw new Error("new-vaults takes legacy or queue");
      return { kind: "new-vaults", system: args[0] };
    default:
      throw new Error(`unknown command${command === undefined ? "" : `: ${command}`}`);
  }
}

/**
 * Runs one command. `heights` is asked only by the commands that wait on the
 * chain (arm, release). Answers what to print and whether the command did what
 * was asked: `ok` false is a refusal or a wait, never an error.
 */
export async function runHandoverCommand(
  command: HandoverCommand,
  deps: { readonly handover: Handover; readonly heights: () => Promise<ChainHeights> },
): Promise<{ readonly ok: boolean; readonly result: unknown }> {
  const { handover } = deps;
  switch (command.kind) {
    case "status":
      return { ok: true, result: await handover.status(command.vault ?? undefined) };
    case "drain": {
      const step = await handover.drain(command.vault);
      return { ok: step.moved, result: step };
    }
    case "rollback": {
      const step = await handover.rollback(command.vault);
      return { ok: step.moved, result: step };
    }
    case "release": {
      const step = await handover.release(command.vault, await deps.heights());
      return { ok: step.moved, result: step };
    }
    case "arm": {
      const options = { requiredRoles: command.requiredRoles, allowDry: command.allowDry };
      const heights = await deps.heights();
      if (command.vault === "all") {
        const steps = await handover.armAll(heights, options);
        return { ok: steps.every((step) => step.moved), result: steps };
      }
      const step = await handover.arm(command.vault, heights, options);
      return { ok: step.moved, result: step };
    }
    case "gone": {
      const marked = await handover.gone(command.processIds === "stale" ? { stale: true } : { processIds: command.processIds });
      return { ok: true, result: { marked } };
    }
    case "new-vaults":
      return { ok: true, result: { newVaultSystem: await handover.setNewVaultSystem(command.system) } };
  }
}
