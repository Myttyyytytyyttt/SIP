// Session detection: walk a wallet's history and decide WHEN a session opened
// and closed. It proposes boundaries; it never claims they are attestable.
// buildSessionReport remains the only authority on that, and it re-derives
// everything from chain state rather than trusting anything computed here.
//
// The design is driven by how these wallets actually trade, measured across six
// real GMGN traders and ~25,000 transactions:
//
//   Partial exits are the norm, not the exception. In one wallet 183 of 479
//   positions were closed across several transactions, often in exact halves.
//   So "the wallet sold" is not "the position is closed", and detection has to
//   track a running quantity rather than react to sell events.
//
//   Positions do not close in the order they opened. A complete round trip was
//   observed nested between the two halves of another position's exit. So a
//   session cannot close on "flat in the token just traded" — it closes only
//   when every position opened inside it is flat, simultaneously.
//
//   Up to 13 positions are held at once.
//
//   No idle-gap threshold works. The p90 hold time (1,964 blocks) is LONGER than
//   the p90 gap between transactions (1,803), so any timeout either cuts live
//   positions in half or merges unrelated sessions. Detection is on position
//   flatness. Time is reported for context and never used as a boundary.

import type { ClassifiedTx } from "./classify.js";

export type SessionState = "IDLE" | "OPEN";

export interface DustRemainder {
  readonly token: string;
  readonly remaining: bigint;
  readonly peak: bigint;
}

export interface DetectedSession {
  /** Boundary for cashStart: the block BEFORE the first acquisition. */
  readonly startBlockL2: bigint;
  /** Boundary for cashEnd: the block where the last position went flat. */
  readonly endBlockL2: bigint;
  readonly tokens: readonly string[];
  readonly buys: number;
  readonly sells: number;
  readonly peakConcurrentPositions: number;
  /**
   * Positions that ended non-zero but below the dust threshold. They are why the
   * session was allowed to close, and they are also why buildSessionReport may
   * still refuse it: the verifier tests exact balances and does not round.
   */
  readonly dust: readonly DustRemainder[];
  /**
   * Unsolicited inbound tokens that landed inside these boundaries. They do not
   * open or extend a session and no longer veto it, but they are surfaced so an
   * operator can see what was in the window.
   */
  readonly airdropsInside: readonly string[];
  readonly spanBlocks: bigint;
}

export interface DetectOptions {
  /**
   * A position counts as closed when what remains is at most this fraction of
   * its peak, in basis points. Exchanges routinely leave a wei or two behind on
   * a "full" sell, and an exact-zero rule would leave such sessions open forever.
   *
   * This is a detection tolerance only. It cannot loosen settlement: the
   * verifier compares exact balances, so a session closed on dust will simply be
   * refused with NOT_DELTA_FLAT, which is visible rather than silent.
   */
  readonly dustBps?: bigint;
}

const DEFAULT_DUST_BPS = 1n; // 0.01% of peak

interface OpenPosition {
  quantity: bigint;
  peak: bigint;
}

/**
 * Groups classified transactions into sessions.
 *
 * Input must be ordered by block. Only TRADE_BUY and TRADE_SELL move the state
 * machine: everything else — approvals, deposits, withdrawals, settlements,
 * airdrops — is recorded but never opens, extends, or closes a session.
 */
export function detectSessions(
  transactions: readonly ClassifiedTx[],
  options: DetectOptions = {},
): DetectedSession[] {
  const dustBps = options.dustBps ?? DEFAULT_DUST_BPS;
  const ordered = [...transactions].sort((a, b) =>
    a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1,
  );

  const sessions: DetectedSession[] = [];
  let state: SessionState = "IDLE";
  let positions = new Map<string, OpenPosition>();
  let tokens = new Set<string>();
  let airdrops = new Set<string>();
  let startBlockL2 = 0n;
  let buys = 0;
  let sells = 0;
  let peakConcurrent = 0;

  const isDust = (position: OpenPosition): boolean => {
    if (position.quantity <= 0n) return true;
    if (position.peak <= 0n) return false;
    return position.quantity * 10_000n <= position.peak * dustBps;
  };

  const openCount = (): number => [...positions.values()].filter((p) => !isDust(p)).length;

  const reset = () => {
    state = "IDLE";
    positions = new Map();
    tokens = new Set();
    airdrops = new Set();
    buys = 0;
    sells = 0;
    peakConcurrent = 0;
  };

  for (const tx of ordered) {
    if (tx.kind === "AIRDROP_IN") {
      if (state === "OPEN") for (const delta of tx.tokenDeltas) airdrops.add(delta.token);
      continue;
    }
    if (tx.kind !== "TRADE_BUY" && tx.kind !== "TRADE_SELL") continue;

    if (state === "IDLE") {
      if (tx.kind !== "TRADE_BUY") continue; // a sell with nothing open belongs to no session we can bound
      // cashStart is measured at the END of startBlockL2, so the boundary must
      // sit before the block that first moves value.
      startBlockL2 = tx.blockNumber - 1n;
      state = "OPEN";
    }

    if (tx.kind === "TRADE_BUY") buys += 1;
    else sells += 1;

    for (const delta of tx.tokenDeltas) {
      tokens.add(delta.token);
      const position = positions.get(delta.token) ?? { quantity: 0n, peak: 0n };
      position.quantity += delta.delta;
      if (position.quantity > position.peak) position.peak = position.quantity;
      positions.set(delta.token, position);
    }

    const concurrent = openCount();
    if (concurrent > peakConcurrent) peakConcurrent = concurrent;

    // Close only when EVERY position opened in this session is flat. Closing on
    // the token just traded would have split the observed nested round trip.
    if (concurrent === 0) {
      const dust: DustRemainder[] = [...positions.entries()]
        .filter(([, p]) => p.quantity > 0n)
        .map(([token, p]) => ({ token, remaining: p.quantity, peak: p.peak }));

      sessions.push({
        startBlockL2,
        endBlockL2: tx.blockNumber,
        tokens: [...tokens].sort(),
        buys,
        sells,
        peakConcurrentPositions: peakConcurrent,
        dust,
        airdropsInside: [...airdrops].sort(),
        spanBlocks: tx.blockNumber - startBlockL2,
      });
      reset();
    }
  }

  return sessions;
}

export interface OpenSessionStatus {
  readonly state: SessionState;
  readonly startBlockL2: bigint | null;
  readonly openTokens: readonly { token: string; quantity: bigint }[];
}

/**
 * The tail of the walk: whether a session is still open right now, and what is
 * holding it open. This is the "standby" state — the wallet has bought something
 * it has not finished selling, so no boundary exists yet and nothing can settle.
 */
export function openSessionStatus(
  transactions: readonly ClassifiedTx[],
  options: DetectOptions = {},
): OpenSessionStatus {
  const dustBps = options.dustBps ?? DEFAULT_DUST_BPS;
  const ordered = [...transactions].sort((a, b) =>
    a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1,
  );

  const positions = new Map<string, OpenPosition>();
  let state: SessionState = "IDLE";
  let startBlockL2: bigint | null = null;

  const isDust = (p: OpenPosition) =>
    p.quantity <= 0n || (p.peak > 0n && p.quantity * 10_000n <= p.peak * dustBps);

  for (const tx of ordered) {
    if (tx.kind !== "TRADE_BUY" && tx.kind !== "TRADE_SELL") continue;
    if (state === "IDLE") {
      if (tx.kind !== "TRADE_BUY") continue;
      startBlockL2 = tx.blockNumber - 1n;
      state = "OPEN";
    }
    for (const delta of tx.tokenDeltas) {
      const position = positions.get(delta.token) ?? { quantity: 0n, peak: 0n };
      position.quantity += delta.delta;
      if (position.quantity > position.peak) position.peak = position.quantity;
      positions.set(delta.token, position);
    }
    if ([...positions.values()].every(isDust)) {
      positions.clear();
      state = "IDLE";
      startBlockL2 = null;
    }
  }

  return {
    state,
    startBlockL2,
    openTokens: [...positions.entries()]
      .filter(([, p]) => !isDust(p))
      .map(([token, p]) => ({ token, quantity: p.quantity }))
      .sort((a, b) => a.token.localeCompare(b.token)),
  };
}
