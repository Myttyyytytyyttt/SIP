// WHICH CODE SETTLES A VAULT, CHOSEN BY THE VAULT'S OWN ON-CHAIN skim_mode
// (dispatcher ADR §3.2: "a mode is a module chosen by the vault's on-chain
// skim_mode"; plan P3a Q3, P4).
//
// UNDER THE QUEUE ONE WORKER SETTLES EVERY MODE. The legacy keepers split the
// modes by ROLE — the profit keeper settles PROFIT, the volume keeper VOLUME
// (src/role-registry.ts, ROLE_PROFILES) — and each passes its own `settles` and
// its own measurement to runSettleTick. A worker's job holds one vault and reads
// its mode byte fresh, so the choice moves here: the byte picks a KeeperMode
// (role-registry.ts, keeperModeFor) and the mode's `base` picks the module that
// knows how to measure it. A job settles the vault's links with `settles` set to
// that one byte, so a vault whose owner changed the mode between the read and
// the attestation is still refused by settle_v2, never charged by the wrong rule.
//
// THIS IS WHERE ROUND-UP AND FIXED AMOUNT PLUG IN (ADR §5, plan P4): a new byte is
// a KeeperMode row, and a row whose `base` is new is a compile error here until
// it has a module — SETTLE_MODULES is a Record over KeeperMode["base"].
//
// A BYTE NO sip-vault VERSION DEFINES HAS NO MODULE: the job then hands the turn
// `settles: []`, and runSettleTick answers UNSUPPORTED_MODE before any RPC call
// (settle-decision.ts, modeDecision), exactly as a legacy keeper does for a mode
// it does not settle.

import type { PublicKey } from "@solana/web3.js";
import type { VaultState } from "./accounts.js";
import type { ManagedLink } from "./discovery.js";
import { tradeNotional } from "./measure-volume.js";
import type { PolicyBoundaryBook, OwnerHistoryReader } from "./policy-boundary.js";
import { keeperModeFor, type KeeperMode } from "./role-registry.js";
import { measurementStart } from "./settle-decision.js";
import type { SettleDeps } from "./settle-tick.js";
import { createVolumeBase } from "./volume-base.js";

/** What a module may need to build a turn's measurement, beside the link and the vault. */
export interface SettleModuleContext {
  readonly link: ManagedLink;
  readonly vault: VaultState;
  readonly programId: PublicKey;
  /** The process's policy-boundary cache (shared by every job: keyed by vault, rebuilt from the chain on a cold worker). */
  readonly boundaries: PolicyBoundaryBook;
  readonly ownerHistory: OwnerHistoryReader;
  readonly nowSeconds: () => number;
}

/** The part of a settle turn's deps a mode decides. */
export type SettleModuleTurn = Pick<SettleDeps, "volumeProbe" | "volumeBase">;

/** One mode's settle code. */
export interface SettleModule {
  readonly mode: KeeperMode;
  /** The measurement this mode's turns run with. */
  turn(context: SettleModuleContext): SettleModuleTurn;
}

/**
 * One module per measurement, as the legacy turns build them (bin/keeper.mts,
 * `volumeTurn`): the balance chain needs nothing beyond the walk; a VOLUME span
 * is measured by the trade-notional probe and charged from the last policy
 * boundary at the vault's cadence.
 */
const SETTLE_MODULES: { readonly [Base in KeeperMode["base"]]: (mode: KeeperMode) => SettleModule } = {
  "balance-chain": (mode) => ({ mode, turn: () => ({}) }),
  "trade-notional": (mode) => ({
    mode,
    turn: ({ link, vault, programId, boundaries, ownerHistory, nowSeconds }) => ({
      volumeProbe: tradeNotional,
      volumeBase: createVolumeBase({
        volumeBps: vault.volumeBps,
        boundary: () =>
          boundaries.boundary({
            reader: ownerHistory,
            programId: programId.toBase58(),
            vault: link.vault,
            owner: vault.owner,
            from: measurementStart(link),
            current: { mode: vault.skimMode, volumeBps: vault.volumeBps },
          }),
        nowSeconds,
      }),
    }),
  }),
};

/** The module for a vault reporting this byte, or null when no sip-vault version defines it. */
export function settleModuleFor(byte: number): SettleModule | null {
  const mode = keeperModeFor(byte);
  return mode === null ? null : SETTLE_MODULES[mode.base](mode);
}
