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
// unproven number never moves money. A walk that never saw the frontier is
// refused the same way, unless the only thing it is missing is finality.

import type { PublicKey } from "@solana/web3.js";
import type { VaultState } from "./accounts.js";
import type { Alert } from "./alerts.js";
import type { ManagedLink } from "./discovery.js";
import { MAX_SIGNATURE_PAGES, MAX_SIGNATURES, type WindowMeasurement } from "./measure-window.js";
import { MODE_PROFIT, MODE_VOLUME, type AttestationInputs } from "./program-scripts.js";

export type SettleOutcome =
  /** Nothing new since the frontier. The resting state of a linked wallet. */
  | "IDLE"
  /**
   * There is activity, and the finalized history the walk reads cannot show it
   * yet: newer transactions are confirmed but not finalized, or the span starts
   * at a slot that is not finalized itself, like a link made seconds ago.
   *
   * A RESTING state with no alert. Finality trails the confirmed tip by a few
   * dozen slots, so the next sweep measures again. Nothing is measured from
   * confirmed data instead, because a slot is never read again once a settle
   * has moved the frontier past it.
   */
  | "PENDING_FINALITY"
  /** New profit measured, attested and settled — or, in dry run, what would be. */
  | "SETTLED"
  /**
   * Measured a loss or zero — for a VOLUME vault, no successful trade — over a
   * span too small to spend a transaction on. Nothing is taken and nothing is sent.
   *
   * A ZERO SETTLE IS WHAT MOVES A FLAT SPAN'S FRONTIER, and this is the wait for
   * one. Nuvem's settle required profit > 0, so a flat or losing span stayed
   * inside the window and grew until the walk refused it, forever. settle_v2
   * accepts a zero base — it moves nothing and still advances the frontier — and
   * baseDecision sends one once ZERO_BASE_MIN_TXS transactions other than our own
   * settles sit in the span. Until then the span rests here and its losses keep
   * netting against the next win; a zero settle forgets them, because TradingLink
   * keeps no high-water mark.
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
  /**
   * The vault saves in a mode no sip-vault version defines, or a VOLUME span holds
   * successful trades whose notional this keeper cannot measure yet. Resting;
   * nothing is attested.
   */
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
 * BOTH MODES ARE MEASURED; ONLY AN UNDEFINED ONE STOPS HERE. A VOLUME vault used
 * to end at this line, and its frontier never moved: a quiet VOLUME link grew
 * toward the walk's read limit like any flat span. It is walked now, with every
 * completeness stop a PROFIT span has, and baseDecision takes its base from the
 * volumeBase seam, which attests a notional only where one is proven. The
 * attestation takes the vault's own mode and rate (attestationInputs), so
 * nothing on chain would refuse a PROFIT number signed for a VOLUME vault: it
 * would verify and be charged at the volume rate. The seam is the only place a
 * VOLUME base comes from.
 */
export function modeDecision(vault: Pick<VaultState, "skimMode">): { readonly outcome: "UNSUPPORTED_MODE"; readonly detail: string } | null {
  if (vault.skimMode === MODE_PROFIT || vault.skimMode === MODE_VOLUME) return null;
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
      readonly outcome: "IDLE" | "INCOMPLETE" | "NO_PROFIT" | "PENDING_FINALITY" | "UNSUPPORTED_MODE";
      readonly detail: string;
      readonly baseLamports?: bigint;
    }
  | { readonly kind: "settle"; readonly baseLamports: bigint; readonly endSlot: bigint };

/**
 * The notional a complete VOLUME span is charged on, in lamports, or null when
 * this keeper cannot measure it. Called only for a span every completeness stop
 * has passed, and never for our own settles alone.
 */
export type VolumeBase = (measured: WindowMeasurement) => Promise<bigint | null>;

/**
 * The production VOLUME base until keeper-medir-volumen: zero for a span with no
 * successful trade, and nothing otherwise.
 *
 * A NOTIONAL IS NEVER GUESSED. A span holding only transfers, our own settles and
 * failed swaps has no notional under Wednesday's own rule — a volume is the
 * successful trades a wallet signs — so its zero is proven, and settling it moves
 * a quiet VOLUME link's frontier. One successful trade makes the number unknown,
 * and an unknown number is never signed: that span rests at UNSUPPORTED_MODE,
 * intact, for keeper-medir-volumen to measure. keeper.mts never passes another;
 * the local proof injects the trade's notional.
 */
export const defaultVolumeBase: VolumeBase = async (measured) => (measured.successfulTradeCount === 0 ? 0n : null);

/**
 * How many transactions other than our own settles a span needs before a zero
 * base is worth a transaction: 100.
 *
 * WHY A COUNT AND NOT A CLOCK. A time trigger measured from the frontier fires on
 * the first trade after any idle stretch and forgets that trade's loss at once.
 * A count lets losses net against the next win for as long as the span is small,
 * and still settles a flat span well before the walk's read limit
 * (MAX_SIGNATURES, 300) could refuse it. The owner can change it.
 */
export const ZERO_BASE_MIN_TXS = 100;

/** Where a turn's walk started, how far finality had come when it did, and how the span is charged. */
export interface MeasurementContext {
  /** measurementStart(link): the slot the walk had to reach. */
  readonly from: bigint;
  /**
   * getSlot("finalized"), READ BEFORE THE WALK. A start at or below it was
   * final before the walk began, so a walk that did not reach it is an endpoint
   * problem. Read after, finality could pass the start during a walk that was
   * merely early, and a truthful PENDING_FINALITY would be reported INCOMPLETE.
   */
  readonly finalizedSlot: bigint;
  /**
   * The vault's skim_mode, REQUIRED. A default would decide a VOLUME span as
   * PROFIT, and the attestation would charge that profit at the volume rate.
   */
  readonly mode: number;
  readonly volumeBase: VolumeBase;
}

/** What a measurement allows, in order — and the order is the point. */
export async function decideFromMeasurement(
  measured: WindowMeasurement,
  { from, finalizedSlot, mode, volumeBase }: MeasurementContext,
): Promise<MeasurementDecision> {
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
  // THE FRONTIER, SEEN OR NOT. A walk that did not see a finalized signature at
  // or below its start measured a window whose oldest part it never read, and
  // used to settle it anyway: an empty page counted as arriving. What it is
  // missing decides the name. Pages first, because no amount of finality
  // brings 20 000 signatures closer.
  if (!measured.frontierReached) {
    if (measured.pagesExhausted) {
      return {
        kind: "stop",
        outcome: "INCOMPLETE",
        detail:
          `walked ${measured.signaturesAbove} signatures over ${MAX_SIGNATURE_PAGES} pages without reaching slot ${from}, ` +
          "where this span starts, so nothing is attested",
      };
    }
    // THE DETAILS NAME NO FINALIZED SLOT. The sweep logs a resting state only
    // when its line changes, and the finalized slot moves every sweep, so a
    // detail that named it would log every wallet waiting here every minute.
    if (from > finalizedSlot) {
      return {
        kind: "stop",
        outcome: "PENDING_FINALITY",
        detail:
          `slot ${from}, where this span starts, is not finalized yet, ` +
          "and the walk reads finalized history only; nothing is attested until it is",
      };
    }
    return {
      kind: "stop",
      outcome: "INCOMPLETE",
      detail:
        `the endpoint's finalized history stops above slot ${from}, where this span starts, although that slot ` +
        "is finalized; the walk never reached the frontier, so nothing is attested",
    };
  }
  // ABOVE THE READ LIMIT, NOTHING WAS READ. The walk refuses before fetching a
  // single transaction of a span this large, so this comes before the empty
  // check below, which would otherwise call it finality catching up. The old
  // detail promised the frontier would catch up; nothing settles part of a
  // span yet, so it does not.
  if (measured.signaturesAbove > MAX_SIGNATURES) {
    return {
      kind: "stop",
      outcome: "INCOMPLETE",
      detail:
        `${measured.signaturesAbove} signatures sit above slot ${from}, more than the ${MAX_SIGNATURES} one settlement reads, ` +
        "so none was read and nothing is attested; the frontier does not move while this holds",
    };
  }
  // REACHED, AND NOTHING FINALIZED ABOVE IT. The turn walks only after a
  // confirmed probe saw a signature above the start, so an empty finalized
  // window is activity finality has not caught up with, not an idle wallet.
  if (measured.txCount === 0) {
    return {
      kind: "stop",
      outcome: "PENDING_FINALITY",
      detail:
        `activity after slot ${from} is confirmed but not finalized yet; ` +
        "the walk reads finalized history only, so nothing is attested until it is",
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
  return baseDecision({ mode, measured, from, volumeBase });
}

/**
 * What a COMPLETE measurement is charged on, and whether it is worth a
 * transaction. decideFromMeasurement calls it once every completeness stop has
 * passed; nothing else should.
 *
 * THE BASE: a PROFIT span's measured profit, and a VOLUME span's notional from
 * the volumeBase seam — null there is UNSUPPORTED_MODE, and nothing is attested.
 * A positive base settles over the measured window. A zero or negative one
 * settles a ZERO base once the span holds ZERO_BASE_MIN_TXS transactions other
 * than our own settles, and rests at NO_PROFIT before that.
 */
export async function baseDecision({
  mode,
  measured,
  from,
  volumeBase,
}: {
  readonly mode: number;
  readonly measured: WindowMeasurement;
  readonly from: bigint;
  readonly volumeBase: VolumeBase;
}): Promise<MeasurementDecision> {
  // THE LOOP GUARD, AND IT COMES FIRST. A settle is external flow
  // (measure-window.ts), so a window holding only the previous settle measures a
  // profit of exactly zero. Without this stop, every zero settle would be
  // followed by another one the next sweep, each paid by the trading wallet,
  // forever. First, before any base: a window with nothing but our own settles
  // holds nothing to charge, so no base — not even one a seam returns — settles it.
  const others = measured.txCount - measured.settleTxCount;
  if (others === 0) {
    return { kind: "stop", outcome: "IDLE", detail: `only our own settle since slot ${from}; nothing to charge` };
  }
  // settle_v2 refuses a window whose end is not above its start
  // (InvalidSessionWindow). A walk that read transactions above the frontier
  // always ends above it; kept so a caller bug is a resting state, not a refusal.
  if (measured.lastSlot <= from) {
    return { kind: "stop", outcome: "IDLE", detail: "no slot beyond the frontier yet" };
  }

  let base: bigint;
  if (mode === MODE_PROFIT) {
    base = measured.profitLamports;
  } else if (mode === MODE_VOLUME) {
    const notional = await volumeBase(measured);
    if (notional === null) {
      return {
        kind: "stop",
        outcome: "UNSUPPORTED_MODE",
        detail: `${measured.successfulTradeCount} successful trade(s) await keeper-medir-volumen; nothing attested`,
      };
    }
    // A u64 on chain. A negative notional is a broken seam, and resting would
    // dress it up as a quiet span.
    if (notional < 0n) throw new Error(`the VOLUME base seam returned ${notional} lamports; a notional is never negative`);
    base = notional;
  } else {
    // modeDecision stops these before anything is measured.
    return { kind: "stop", outcome: "UNSUPPORTED_MODE", detail: `skim_mode ${mode} is not a mode this keeper measures; nothing attested` };
  }

  if (base > 0n) return { kind: "settle", baseLamports: base, endSlot: measured.lastSlot };
  // A ZERO SETTLE ONCE THE SPAN IS WORTH ONE. It moves nothing and advances the
  // frontier past everything measured, so the span can never grow into the walk's
  // read limit. (keeper-cobro-v2's backlog prefix joins this condition when it
  // lands: a prefix is settled whatever its size.)
  if (others >= ZERO_BASE_MIN_TXS) return { kind: "settle", baseLamports: 0n, endSlot: measured.lastSlot };
  const what =
    mode === MODE_VOLUME
      ? `no successful trade over ${measured.txCount} txs, so the notional is zero`
      : `measured ${base} lamports over ${measured.txCount} txs — a losing or flat span`;
  return {
    kind: "stop",
    outcome: "NO_PROFIT",
    detail:
      `${what}; a zero settle advances the frontier at ${ZERO_BASE_MIN_TXS} transactions other than our own settles, ` +
      `${ZERO_BASE_MIN_TXS - others} to go`,
    baseLamports: base,
  };
}

/** What one settle outcome raises and resolves, as keeper.mts applies it. */
export interface SettleAlertRule {
  /** The alert this outcome raises, or null. */
  readonly fire: Alert | null;
  /** The keys this outcome resolves, so their next occurrence alerts again. */
  readonly clear: readonly string[];
}

/**
 * The outcome-to-alert rule for one wallet's settle turn, pure so a test can pin
 * it for every outcome.
 *
 * MONEY THAT SHOULD HAVE MOVED AND DID NOT IS CRITICAL: FAILED. The resting states
 * each explain themselves and fire nothing — IDLE, PENDING_FINALITY, NO_PROFIT and
 * UNSUPPORTED_MODE — except the two a human must act on: INCOMPLETE, the one
 * resting state that never resolves itself (the frontier cannot advance while it
 * holds), and NO_SIGNER, which repeats until the user re-runs onboarding. Both
 * warn, and each outcome other than itself clears it.
 *
 * A PAUSE IS DELIBERATE, NOT MONEY LOST. It also explains the settles that were
 * refused with VaultPaused or ProtocolPaused while it was being switched on, so it
 * clears their critical alert instead of leaving it standing. A SETTLED clears it
 * too; nothing else does.
 */
export function settleAlert(
  outcome: SettleOutcome,
  where: { readonly wallet: string; readonly vault: string },
  detail: string,
): SettleAlertRule {
  const { wallet, vault } = where;
  const failed = `settle-failed:${wallet}`;
  const incomplete = `incomplete:${wallet}`;
  const noSigner = `no-signer:${wallet}`;
  switch (outcome) {
    case "FAILED":
      return {
        fire: { key: failed, severity: "critical", title: "A settlement failed", detail, context: { wallet, vault } },
        clear: [],
      };
    case "SETTLED":
      return { fire: null, clear: [failed] };
    case "PAUSED":
      return { fire: null, clear: [failed, incomplete, noSigner] };
    case "INCOMPLETE":
      return {
        fire: { key: incomplete, severity: "warn", title: "A wallet cannot be measured, so it is not saving", detail, context: { wallet } },
        clear: [noSigner],
      };
    case "NO_SIGNER":
      return {
        fire: { key: noSigner, severity: "warn", title: "A linked wallet never granted the keeper's signer", detail, context: { wallet } },
        clear: [incomplete],
      };
    case "IDLE":
    case "PENDING_FINALITY":
    case "NO_PROFIT":
    case "UNSUPPORTED_MODE":
      return { fire: null, clear: [incomplete, noSigner] };
  }
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
