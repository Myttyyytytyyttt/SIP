// Incremental session discovery, with a watermark.
//
// THE WATERMARK IS AN "IDLE ANCHOR", NOT DETECTOR STATE.
//
// detectSessions is a fold over a classified transaction list with mutable
// position state. The obvious way to make ticks incremental is to persist that
// position map. Do not. It becomes a second source of truth about what the
// wallet holds, it can drift from chain reality, and drift there silently
// mislocates a session boundary — which then silently mislocates the profit.
//
// Instead persist ONE number: `anchorBlockL2`, the highest L2 block at which the
// wallet was provably IDLE, meaning every position flat. IDLE is an EMPTY state,
// so re-running detection from the anchor forward reproduces byte-identical
// sessions with no carried state at all. The anchor is a cursor into chain
// history, not a cache of a computation. Losing it costs time; it cannot cost
// correctness.
//
// The anchor also never advances past a point the wallet was not flat, and it
// never needs rolling back for a deferred settlement — deferred and refused
// windows are recorded explicitly in the journal instead.
//
// SPAN LIMITS FAIL CLOSED. Two independent ceilings exist, and neither degrades
// into a partial answer:
//
//   * maxTickScanSpanBlocks bounds the DISCOVERY scan. Exceeding it abandons the
//     tick with no verdict, because the alternative — scanning part of the range
//     — would answer from less evidence while looking exactly like a full answer.
//   * maxVerifySpanBlocks bounds the DENSE verification of one session. A wider
//     session is recorded SPAN_TOO_WIDE and reported, never silently dropped and
//     never split: a sub-window is not flat-to-flat and would refuse anyway, and
//     a keeper that invents its own boundaries is a keeper that invents its own
//     profit.

import {
  classifyWindow,
  detectSessions,
  openSessionStatus,
  scanWindow,
  type ClassifiedTx,
  type DetectedSession,
  type OpenSessionStatus,
  type RpcClient,
} from "./engine.js";
import { windowKey, type SkipReason, type WindowRef } from "./ledger.js";

export interface ScanBounds {
  readonly fromBlockL2: bigint;
  readonly toBlockL2: bigint;
}

/**
 * The half-open window (anchor, safeHead] this tick may look at.
 *
 * `null` means there is nothing new worth looking at yet, which is the ordinary
 * outcome most of the time and must not read as an error.
 */
export function tickScanBounds(input: {
  readonly anchorBlockL2: bigint;
  readonly headBlockL2: bigint;
  readonly finalityMarginL2: bigint;
  readonly maxTickScanSpanBlocks: bigint;
}):
  | { readonly kind: "IDLE" }
  | { readonly kind: "SCAN"; readonly bounds: ScanBounds; readonly behindBy: bigint } {
  // Nothing inside the finality margin is detected, verified or anchored, so a
  // sequencer reorg cannot move a boundary the keeper already committed to.
  const safeHead = input.headBlockL2 > input.finalityMarginL2 ? input.headBlockL2 - input.finalityMarginL2 : 0n;
  if (safeHead <= input.anchorBlockL2) return { kind: "IDLE" };

  // A gap wider than the limit is SCANNED IN PART, not refused.
  //
  // This used to return TOO_WIDE, on the reasoning that "a truncated scan is
  // worse than a slow one: it answers from less evidence while looking like a
  // full answer." That is true of a PROVIDER silently truncating a range — an
  // incomplete answer about the window you asked for. It is not true of asking
  // for a smaller window on purpose, which is a complete answer about less
  // chain, and is exactly what every ordinary tick already does.
  //
  // Refusing instead made falling behind unrecoverable: the keeper declined to
  // scan, the gap grew every block, and it re-declined forever while reporting
  // healthy ticks. A keeper that cannot catch up is a user who silently stops
  // saving, which is far worse than a slow one.
  //
  // Correctness at the truncated edge is already handled by planTick's anchor
  // rule: a session still open when the window ends pins the anchor back at its
  // start, so it is re-measured whole rather than cut in half. `behindBy` is
  // reported so "catching up" is never mistaken for "current".
  const toBlockL2 =
    safeHead - input.anchorBlockL2 > input.maxTickScanSpanBlocks
      ? input.anchorBlockL2 + input.maxTickScanSpanBlocks
      : safeHead;

  return {
    kind: "SCAN",
    bounds: { fromBlockL2: input.anchorBlockL2, toBlockL2 },
    behindBy: safeHead - toBlockL2,
  };
}

export interface DiscoveredWindow {
  readonly transactions: readonly ClassifiedTx[];
  readonly sessions: readonly DetectedSession[];
  readonly openStatus: OpenSessionStatus;
  readonly expectedSentCount: number;
  readonly observedSentCount: number;
}

/**
 * Scans (from, to] and asks the detector for boundaries.
 *
 * This is the engine's full four-source scan, which is the only thing that sees
 * the gas-only `approve` before each GMGN sell — those emit no Transfer, cost
 * real gas, and omitting them breaks reconciliation by exactly the gas. It is
 * also the only source of sell proceeds, because the router unwraps WETH and
 * forwards native ETH by internal call with no log at all.
 *
 * Detection here PROPOSES boundaries. It never claims they are attestable:
 * buildSessionReport re-derives everything from chain state and remains the only
 * authority on that.
 */
export async function discoverSessions(
  rpc: RpcClient,
  wallet: string,
  bounds: ScanBounds,
): Promise<DiscoveredWindow> {
  const scan = await scanWindow(rpc, wallet, bounds.fromBlockL2, bounds.toBlockL2);
  const transactions = classifyWindow(scan.txs, wallet);
  return {
    transactions,
    sessions: detectSessions(transactions),
    openStatus: openSessionStatus(transactions),
    expectedSentCount: scan.expectedSentCount,
    observedSentCount: scan.observedSentCount,
  };
}

export interface TickPlan {
  /** Where the watermark moves to once this tick's work is recorded. */
  readonly nextAnchorL2: bigint;
  /** Closed sessions worth verifying densely, oldest first. */
  readonly candidates: readonly DetectedSession[];
  /** Closed sessions too wide for the dense verifier. Terminal, and reported. */
  readonly tooWide: readonly DetectedSession[];
  /** Closed sessions the journal has already finished with. */
  readonly alreadyHandled: readonly { readonly session: DetectedSession; readonly reason: string }[];
  /**
   * An open session that is ALREADY wider than the dense verifier's limit, so
   * waiting for its close cannot help — wherever it closes, the window exceeds
   * maxVerifySpanBlocks and would be refused as SPAN_TOO_WIDE. Reported so the
   * caller journals the abandonment; the anchor no longer pins to it.
   */
  readonly abandonedOpen: {
    readonly startBlockL2: bigint;
    readonly scannedTo: bigint;
    readonly openTokens: readonly string[];
  } | null;
}

/**
 * The pure half of a tick. No I/O, so it is fully covered by offline tests.
 *
 * Ordering matters: candidates come back in block order, and the caller verifies
 * at most one per tick. Settling oldest-first is what keeps the vault's
 * monotone-progression guard satisfiable — settle a later window first and every
 * earlier one is foreclosed permanently.
 */
export function planTick(input: {
  readonly sessions: readonly DetectedSession[];
  readonly openStatus: OpenSessionStatus;
  readonly scannedTo: bigint;
  readonly anchorBlockL2: bigint;
  readonly maxVerifySpanBlocks: bigint;
  readonly terminalWindows: ReadonlyMap<string, SkipReason>;
  // NOTE: settled boundaries are deliberately NOT an input here. Progression is
  // checked once, in localEligibility, against the journal — and again against the
  // chain. Duplicating it here would create a second place for the rule to drift,
  // and a candidate the chain will refuse is not the same thing as a candidate not
  // worth verifying: the verification is what produces the auditable refusal record.
}): TickPlan {
  const ordered = [...input.sessions].sort((a, b) =>
    a.endBlockL2 === b.endBlockL2 ? 0 : a.endBlockL2 < b.endBlockL2 ? -1 : 1,
  );

  const candidates: DetectedSession[] = [];
  const tooWide: DetectedSession[] = [];
  const alreadyHandled: { session: DetectedSession; reason: string }[] = [];

  for (const session of ordered) {
    const key = windowKey(session as WindowRef);
    const terminal = input.terminalWindows.get(key);
    if (terminal !== undefined) {
      alreadyHandled.push({ session, reason: `terminal: ${terminal}` });
      continue;
    }
    if (session.endBlockL2 - session.startBlockL2 > input.maxVerifySpanBlocks) {
      tooWide.push(session);
      continue;
    }
    candidates.push(session);
  }

  // The anchor rule. openSessionStatus returning OPEN means the wallet bought
  // something it has not finished selling, so the last provably-flat point is the
  // block before that first acquisition — which is exactly what the detector
  // records as startBlockL2.
  //
  // PINNED ONLY WHILE THE SESSION COULD STILL BE VERIFIED. Pinning exists so a
  // session still open at the window's edge is re-measured whole next tick. But
  // the scan window is (anchor, anchor + maxTickScanSpanBlocks], so a pinned
  // anchor also freezes the window — and a session whose close lies beyond that
  // edge was re-scanned identically forever: behindBy grew every block, the same
  // 30k blocks burned thousands of RPC calls a tick, and every trade after the
  // open was invisible. A real account hit exactly this — two positions held
  // longer than the span — and its owner kept trading into a keeper that had
  // stopped watching.
  //
  // The escape is the width rule the closed path already has: once the session
  // is wider than maxVerifySpanBlocks measured to the scan edge, it exceeds the
  // dense verifier's limit no matter where it eventually closes, so waiting has
  // no remaining purpose. Abandon it exactly as a closed too-wide session is
  // abandoned — journaled, reported, terminal — and let the anchor advance. The
  // detector ignores the eventual unmatched sells by design ("a sell with
  // nothing open belongs to no session we can bound"), and buildSessionReport
  // stays the authority on anything that does get proposed afterwards.
  const openStart = input.openStatus.state === "OPEN" ? input.openStatus.startBlockL2 : null;
  const openIsHopeless = openStart !== null && input.scannedTo - openStart > input.maxVerifySpanBlocks;

  let nextAnchorL2 = openStart !== null && !openIsHopeless ? openStart : input.scannedTo;

  const abandonedOpen =
    openStart !== null && openIsHopeless
      ? {
          startBlockL2: openStart,
          scannedTo: input.scannedTo,
          openTokens: input.openStatus.openTokens.map((position) => position.token),
        }
      : null;

  // Never move backwards. A backwards anchor would re-offer windows the journal
  // has already finished with, and while the eligibility rules would refuse them,
  // doing so costs a dense verification every tick, forever.
  if (nextAnchorL2 < input.anchorBlockL2) nextAnchorL2 = input.anchorBlockL2;

  return { nextAnchorL2, candidates, tooWide, alreadyHandled, abandonedOpen };
}

/** What the detector's boundaries mean for buildSessionReport's arguments. */
export interface VerifyRequest {
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  readonly replayStartBlockL2: bigint;
}

/**
 * Attest exactly the detector's own boundaries.
 *
 * `replayStartBlockL2 === startBlockL2` is required, not merely conventional:
 * session.ts pushes REPLAY_TOO_SHORT whenever `replayStartBlockL2 >
 * startBlockL2`, and a hand-widened or hand-narrowed window is precisely what
 * the whole engine exists to prevent. Note the asymmetry: passing equality
 * ASSERTS "I know the provenance of everything held at the start boundary"; the
 * engine does not verify that claim directly. It is enforced instead by
 * `uncovered > 0` from the inventory replay and by NOT_DELTA_FLAT comparing
 * exact start and end balances — which is why a session the detector closed on
 * dust is refused rather than settled.
 */
export function verifyRequestFor(session: DetectedSession): VerifyRequest {
  return {
    startBlockL2: session.startBlockL2,
    endBlockL2: session.endBlockL2,
    replayStartBlockL2: session.startBlockL2,
  };
}
