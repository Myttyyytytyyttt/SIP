// The settle tick's decisions, as pure functions.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/settle-tick.ts), where every
// one of these lived inline between RPC calls — so a test had to fake a
// Connection, an Anchor Program and a Transaction to reach a branch. Here they
// take the measurement and the vault as values and return the outcome;
// settle-tick.ts only fetches, calls these, and sends.
//
// THE FRONTIER IS THE WHOLE DIFFERENCE FROM THE DRILL. The drill measured a
// wallet's entire recent history because that history was one simulated
// session. A real tester trading on Axiom accumulates sessions, and settling
// the same profit twice is the one failure here that costs money. So the tick
// measures ONLY what happened after the link's own watermark, advanced by the
// program on every settle. Profit already settled is invisible to the next tick
// by construction, not by bookkeeping.
//
// IT REFUSES RATHER THAN GUESSES. A broken balance chain means a transaction was
// missed, so the measurement is incomplete and no attestation is signed: an
// unproven number never moves money.

import type { PublicKey } from "@solana/web3.js";
import type { VaultState } from "./accounts.js";
import type { ManagedLink } from "./discovery.js";
import { MAX_SIGNATURES, type WindowMeasurement } from "./measure-window.js";
import { MODE_PROFIT, MODE_VOLUME, type AttestationInputs } from "./program-scripts.js";

export type SettleOutcome =
  /** Nothing new since the frontier. The resting state of a linked wallet. */
  | "IDLE"
  /** New profit measured, attested and settled — or, in dry run, what would be. */
  | "SETTLED"
  /**
   * Measured a loss or zero, so nothing is taken.
   *
   * THE FRONTIER DOES NOT ADVANCE, still. Nuvem's settle required profit > 0,
   * so a flat or losing span stayed inside the window and kept growing until it
   * exceeded the walk limit and flipped to INCOMPLETE, which never resolves.
   * settle_v2 accepts a ZERO base — it moves nothing and advances the frontier —
   * which closes that wedge on chain. This tick does not send one yet:
   * keeper-cobro-v2 switches NO_PROFIT to a zero-base settle together with the
   * cadence that decides when a flat span is worth a transaction.
   */
  | "NO_PROFIT"
  /** The completeness oracle broke — a human should look. */
  | "INCOMPLETE"
  /**
   * LIVE ONLY. The wallet has no signer this keeper can use. A RESTING state,
   * not a failure: it repeats every sweep until the user re-runs onboarding, so
   * the keeper dedupes it rather than logging a settle FAILED each minute. A dry
   * run never reports it, because resolving a signer needs the Privy secrets a
   * dry run does not read.
   */
  | "NO_SIGNER"
  /** The vault saves in a mode this keeper cannot measure yet. Nothing is attested. */
  | "UNSUPPORTED_MODE"
  /**
   * The vault's owner paused it, or the protocol's authority paused everything.
   * A RESTING state, not a failure: settle_v2 refuses both, so sending would
   * only burn a fee and fire a critical alert every sweep for a switch someone
   * turned on deliberately. Nothing is measured or attested, and the frontier
   * stays where it is, so the span settles once the switch is off.
   */
  | "PAUSED"
  | "FAILED";

/**
 * How long an attestation stays submittable: 150 slots past the confirmed slot
 * it was built at, about a minute at 400 ms a slot.
 *
 * WHY 150. It is the lifetime of the blockhash the settle transaction carries
 * (150 blocks), so no deadline this keeper signs outlives every transaction
 * that could deliver it: a settle that has not landed when its blockhash
 * expires can never land, and a longer deadline would only widen the window in
 * which a signed-but-unsent attestation is worth something to whoever holds
 * it. Slots are skipped more often than blocks, so the deadline can pass a
 * little before the blockhash does — the safe direction: settle_v2 refuses with
 * AttestationExpired, the frontier stays put, and the next sweep measures
 * again.
 */
export const ATTESTATION_VALIDITY_SLOTS = 150n;

/**
 * Where a turn's measurement starts: the frontier, or the link's birth.
 *
 * A NEVER-SETTLED LINK STARTS AT ITS OWN CREATION, not at slot zero. The
 * program writes frontier_slot 0 at link time and `epoch` = the creation slot,
 * so zero means "nothing settled yet", not "measure everything". Reading it
 * literally walked the wallet's entire pre-link history: it truncated at the
 * walk limit (INCOMPLETE forever, a deadlock) and would have skimmed profit the
 * user earned before they ever joined.
 */
export function measurementStart(link: Pick<ManagedLink, "epoch" | "frontierSlot">): bigint {
  return link.frontierSlot === 0n ? link.epoch : link.frontierSlot;
}

/**
 * Whether this keeper can settle the vault's mode at all. Decided BEFORE
 * measuring, in dry run too.
 *
 * NOTHING ON CHAIN BACKS THIS STOP ANY MORE. The attestation takes the vault's
 * own mode and rate (attestationInputs), so a PROFIT measurement handed to it
 * for a VOLUME vault would no longer be refused as SkimModeMismatch: it would be
 * signed as a notional, verify, and be charged at the volume rate — a number the
 * owner never agreed to be charged on. Until keeper-medir-volumen measures
 * volume, a VOLUME vault ends here.
 */
export function modeDecision(vault: Pick<VaultState, "skimMode">): { readonly outcome: "UNSUPPORTED_MODE"; readonly detail: string } | null {
  if (vault.skimMode === MODE_PROFIT) return null;
  if (vault.skimMode === MODE_VOLUME) {
    return {
      outcome: "UNSUPPORTED_MODE",
      detail:
        "this vault saves a share of VOLUME (skim_mode 1); volume measurement arrives with keeper-medir-volumen, " +
        "so nothing is measured or attested",
    };
  }
  return {
    outcome: "UNSUPPORTED_MODE",
    detail: `this vault reports skim_mode ${vault.skimMode}, which no sip-vault version defines; nothing is attested`,
  };
}

/**
 * Whether either pause switch stops this settle. Decided right after the vault
 * is read and BEFORE the mode, in settle.rs's own order, in dry run too: a dry
 * run that reports "would settle" for a paused vault describes a settlement the
 * program would refuse.
 */
export function pauseDecision(
  vault: Pick<VaultState, "paused">,
  protocolPaused: boolean,
): { readonly outcome: "PAUSED"; readonly detail: string } | null {
  if (!vault.paused && !protocolPaused) return null;
  const switches = [
    vault.paused ? "the vault's owner paused it (VaultPaused)" : null,
    protocolPaused ? "the protocol's authority paused every vault (ProtocolPaused)" : null,
  ].filter((part): part is string => part !== null);
  return {
    outcome: "PAUSED",
    detail:
      `${switches.join(" and ")}: settle_v2 refuses, so nothing is measured or attested. ` +
      "The frontier stays put and the span settles once the switch is off; withdraw is never paused",
  };
}

export function noSignerDetail(wallet: PublicKey): string {
  return (
    `no signer for trading wallet ${wallet.toBase58()} — settle_v2 is pushed BY the wallet, ` +
    "so the keeper needs its Privy signer (or, on localnet, a local key); re-run onboarding step 3"
  );
}

export type MeasurementDecision =
  | {
      readonly kind: "stop";
      readonly outcome: "IDLE" | "INCOMPLETE" | "NO_PROFIT";
      readonly detail: string;
      readonly baseLamports?: bigint;
    }
  | { readonly kind: "settle"; readonly baseLamports: bigint; readonly endSlot: bigint };

/** What a measurement allows, in the old tick's order — and the order is the point. */
export function decideFromMeasurement(measured: WindowMeasurement, from: bigint): MeasurementDecision {
  // UNFETCHABLE FIRST. This used to run after the empty check, so a span where
  // the RPC returned null for EVERY transaction — exactly what heavy throttling
  // looks like — reported "nothing since slot N" and went quiet. An empty walk
  // is only empty if we could actually see.
  if (measured.unfetchable > 0) {
    return {
      kind: "stop",
      outcome: "INCOMPLETE",
      detail:
        `${measured.unfetchable} transaction(s) in this span could not be read from the RPC — ` +
        "the measurement is incomplete because of OUR node, not the wallet. Nothing is attested; " +
        "the next sweep retries the same span",
    };
  }
  if (measured.txCount === 0) {
    return { kind: "stop", outcome: "IDLE", detail: `nothing since slot ${from}` };
  }
  if (measured.truncated) {
    return {
      kind: "stop",
      outcome: "INCOMPLETE",
      detail:
        `the unsettled span exceeds the ${measured.txCount}-tx walk limit — measured only part of it, ` +
        "so nothing is attested (the frontier will catch up as earlier spans settle)",
    };
  }
  if (measured.chainBreaks > 0) {
    return {
      kind: "stop",
      outcome: "INCOMPLETE",
      detail:
        `${measured.chainBreaks} balance-chain break(s) over ${measured.txCount} transactions — ` +
        "a transaction was missed, so the measurement is incomplete and nothing will be attested",
    };
  }
  if (measured.profitLamports <= 0n) {
    return {
      kind: "stop",
      outcome: "NO_PROFIT",
      detail:
        `measured ${measured.profitLamports} lamports over ${measured.txCount} txs — a losing or flat span` +
        // The frontier does not move without a settle, so this span is
        // re-walked in full every sweep and keeps growing.
        (measured.txCount > 200
          ? ` — WARNING: this unsettled span is ${measured.txCount} transactions and the walk stops at ${MAX_SIGNATURES}; ` +
            "past that the wallet reports INCOMPLETE and stops being measurable"
          : ""),
      baseLamports: measured.profitLamports,
    };
  }
  if (measured.lastSlot <= from) {
    return { kind: "stop", outcome: "IDLE", detail: "no slot beyond the frontier yet" };
  }
  return { kind: "settle", baseLamports: measured.profitLamports, endSlot: measured.lastSlot };
}

/**
 * The rate settle_v2 applies to a vault: its VOLUME rate in VOLUME mode and its
 * PROFIT rate otherwise, exactly as state.rs's `Vault::active_bps` reads it.
 *
 * THE PROGRAM'S BRANCH, NOT A TIDIER ONE. active_bps() tests `== MODE_VOLUME`
 * and gives skim_bps to everything else, so a mode no version defines reads the
 * PROFIT rate here too. modeDecision stops such a vault before anything is
 * attested; if one ever got through, these bytes would still be the ones the
 * program rebuilds.
 */
export function activeBps(vault: Pick<VaultState, "skimMode" | "skimBps" | "volumeBps">): number {
  return vault.skimMode === MODE_VOLUME ? vault.volumeBps : vault.skimBps;
}

/**
 * The attestation a settle signs, in the vault's own mode.
 *
 * EVERY FIELD IS ONE settle_v2 REBUILDS FROM CHAIN STATE, which is why none of
 * them is configured here: the mode is the vault's skim_mode, the rate is its
 * activeBps and the policy nonce is its own, so an attestation made for another
 * mode, another rate or a policy the owner has since rewritten is a different
 * byte string and is refused. This builder once hard-coded mode 0 and skim_bps,
 * which was right only because every other mode stopped first; the program's
 * golden vector is a VOLUME attestation, and attestation-golden.test.ts has this
 * builder reproduce it byte for byte.
 *
 * THE WINDOW STARTS WHERE THE MEASUREMENT DID, OR NOTHING IS BUILT. settle_v2
 * refuses a start below the frontier but checks nothing above it, and nothing
 * against the epoch: a start past measurementStart would settle the later span
 * and forgive every slot in between, and a never-settled link's start below its
 * epoch would charge trading from before the user linked. Either is a caller
 * bug, and an attestation is the one place it must not pass quietly.
 */
export function attestationInputs(args: {
  readonly programId: PublicKey;
  readonly link: Pick<ManagedLink, "wallet" | "vault" | "epoch" | "settlementNonce" | "frontierSlot">;
  readonly vault: Pick<VaultState, "skimMode" | "skimBps" | "volumeBps" | "policyNonce">;
  readonly from: bigint;
  readonly endSlot: bigint;
  readonly baseLamports: bigint;
  readonly currentSlot: bigint;
}): AttestationInputs {
  const start = measurementStart(args.link);
  if (args.from !== start) {
    throw new Error(
      `refusing to build an attestation from slot ${args.from}: this link's unsettled span starts at slot ${start}, ` +
        "and a window that starts anywhere else would charge or forgive slots it should not",
    );
  }
  return {
    programId: args.programId,
    wallet: args.link.wallet,
    vault: args.link.vault,
    linkEpoch: args.link.epoch,
    settlementNonce: args.link.settlementNonce,
    sessionStartSlot: args.from,
    sessionEndSlot: args.endSlot,
    baseLamports: args.baseLamports,
    mode: args.vault.skimMode,
    bps: activeBps(args.vault),
    policyNonce: args.vault.policyNonce,
    validUntilSlot: args.currentSlot + ATTESTATION_VALIDITY_SLOTS,
  };
}

/** What settle_v2 moves for a base, computed as the program computes it: floor(base × bps / 10 000), clipped at max_contribution. */
export function expectedContribution(baseLamports: bigint, bps: number, maxContribution: bigint): { owed: bigint; paid: bigint } {
  const owed = (baseLamports * BigInt(bps)) / 10_000n;
  return { owed, paid: owed < maxContribution ? owed : maxContribution };
}
