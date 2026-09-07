// Every scenario here is a pattern measured on real GMGN traders during the
// coverage sweep, not an invented edge case.

import { describe, expect, it } from "vitest";
import { detectSessions, openSessionStatus } from "./detector.js";
import type { ClassifiedTx, TxKind } from "./classify.js";

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const JUNK = "0xdead000000000000000000000000000000000003";

let counter = 0;
const tx = (
  kind: TxKind,
  blockNumber: bigint,
  deltas: [string, bigint][],
): ClassifiedTx => ({
  hash: `0x${(counter++).toString(16).padStart(64, "0")}`,
  blockNumber,
  kind,
  cashIn: kind === "TRADE_SELL" ? 1000n : 0n,
  cashOut: kind === "TRADE_BUY" ? 1000n : 0n,
  gasPaid: 10n,
  tokenDeltas: deltas.map(([token, delta]) => ({ token, delta })),
  selfSent: kind !== "AIRDROP_IN",
  note: "",
});

describe("the simple case: buy then sell", () => {
  it("opens before the buy and closes on the sell", () => {
    const [session, ...rest] = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 500n]]),
      tx("TRADE_SELL", 120n, [[A, -500n]]),
    ]);
    expect(rest).toHaveLength(0);
    // cashStart is read at the END of startBlockL2, so it must precede the buy.
    expect(session!.startBlockL2).toBe(99n);
    expect(session!.endBlockL2).toBe(120n);
    expect(session!.buys).toBe(1);
    expect(session!.sells).toBe(1);
  });
});

describe("partial exits, which are the norm rather than the exception", () => {
  it("stays open through a half sell and closes on the second", () => {
    // Measured repeatedly: positions exited in two exact halves.
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 1000n]]),
      tx("TRADE_SELL", 110n, [[A, -500n]]),
      tx("TRADE_SELL", 130n, [[A, -500n]]),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endBlockL2).toBe(130n);
    expect(sessions[0]!.sells).toBe(2);
  });

  it("does not close on the first sell", () => {
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 1000n]]),
      tx("TRADE_SELL", 110n, [[A, -500n]]),
    ]);
    // Still holding half. "The wallet sold" is not "the position is closed".
    expect(sessions).toHaveLength(0);
    expect(openSessionStatus([
      tx("TRADE_BUY", 100n, [[A, 1000n]]),
      tx("TRADE_SELL", 110n, [[A, -500n]]),
    ]).state).toBe("OPEN");
  });
});

describe("a round trip nested inside another position's lifetime", () => {
  it("does not split the session at the inner close", () => {
    // Observed live: token B opened and fully closed between the two halves of
    // token A's exit. Closing on "flat in the token just traded" would have cut
    // this into two sessions, each of which is not delta-flat and cannot attest.
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 1000n]]),
      tx("TRADE_SELL", 110n, [[A, -500n]]),
      tx("TRADE_BUY", 115n, [[B, 200n]]),
      tx("TRADE_SELL", 118n, [[B, -200n]]), // B flat, but A still half open
      tx("TRADE_SELL", 130n, [[A, -500n]]),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startBlockL2).toBe(99n);
    expect(sessions[0]!.endBlockL2).toBe(130n);
    expect(sessions[0]!.tokens).toEqual([A, B].sort());
  });
});

describe("concurrency", () => {
  it("closes only when every position opened inside is flat", () => {
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 100n]]),
      tx("TRADE_BUY", 101n, [[B, 100n]]),
      tx("TRADE_SELL", 102n, [[A, -100n]]),
      tx("TRADE_SELL", 103n, [[B, -100n]]),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endBlockL2).toBe(103n);
    expect(sessions[0]!.peakConcurrentPositions).toBe(2);
  });

  it("reports a session still open when one leg never closes", () => {
    const status = openSessionStatus([
      tx("TRADE_BUY", 100n, [[A, 100n]]),
      tx("TRADE_BUY", 101n, [[B, 100n]]),
      tx("TRADE_SELL", 102n, [[A, -100n]]),
    ]);
    expect(status.state).toBe("OPEN");
    expect(status.openTokens).toEqual([{ token: B, quantity: 100n }]);
  });
});

describe("dust", () => {
  it("treats a wei left behind as closed", () => {
    // An exact-zero rule would leave this session open forever.
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 1_000_000n]]),
      tx("TRADE_SELL", 110n, [[A, -999_999n]]),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.dust).toEqual([{ token: A, remaining: 1n, peak: 1_000_000n }]);
  });

  it("does not treat a real remaining position as dust", () => {
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 1_000_000n]]),
      tx("TRADE_SELL", 110n, [[A, -900_000n]]),
    ]);
    expect(sessions).toHaveLength(0);
  });
});

describe("airdrops", () => {
  it("neither opens a session nor extends one", () => {
    const sessions = detectSessions([
      tx("AIRDROP_IN", 50n, [[JUNK, 40n]]),
      tx("TRADE_BUY", 100n, [[A, 100n]]),
      tx("AIRDROP_IN", 105n, [[JUNK, 40n]]),
      tx("TRADE_SELL", 110n, [[A, -100n]]),
      tx("AIRDROP_IN", 200n, [[JUNK, 40n]]),
    ]);
    // A stranger cannot keep the session open, and cannot start one either.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startBlockL2).toBe(99n);
    expect(sessions[0]!.endBlockL2).toBe(110n);
    expect(sessions[0]!.tokens).toEqual([A]);
  });

  it("still surfaces the ones that landed inside the boundaries", () => {
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 100n]]),
      tx("AIRDROP_IN", 105n, [[JUNK, 40n]]),
      tx("TRADE_SELL", 110n, [[A, -100n]]),
    ]);
    // Not a veto, but the operator should be able to see it.
    expect(sessions[0]!.airdropsInside).toEqual([JUNK]);
  });
});

describe("noise that must not move the state machine", () => {
  it("ignores approvals, deposits, withdrawals and settlements", () => {
    const sessions = detectSessions([
      tx("EXTERNAL_DEPOSIT", 90n, []),
      tx("TRADE_BUY", 100n, [[A, 100n]]),
      tx("APPROVE_OR_NOOP", 109n, []),
      tx("TRADE_SELL", 110n, [[A, -100n]]),
      tx("SETTLEMENT", 115n, []),
      tx("EXTERNAL_WITHDRAWAL", 120n, []),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endBlockL2).toBe(110n);
  });
});

describe("consecutive sessions", () => {
  it("separates them at the flat point rather than by elapsed time", () => {
    // The gap between these is smaller than the hold time within them, which is
    // exactly why no idle-gap threshold can do this job: measured p90 hold
    // (1,964 blocks) exceeds p90 idle gap (1,803).
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 100n]]),
      tx("TRADE_SELL", 200n, [[A, -100n]]),
      tx("TRADE_BUY", 205n, [[B, 100n]]),
      tx("TRADE_SELL", 300n, [[B, -100n]]),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.endBlockL2).toBe(200n);
    expect(sessions[1]!.startBlockL2).toBe(204n);
    expect(sessions[1]!.tokens).toEqual([B]);
  });
});

describe("re-buying a token that was already closed", () => {
  it("starts a new session rather than reopening the old one", () => {
    // 95 tokens in one swept wallet were re-opened after being fully closed.
    const sessions = detectSessions([
      tx("TRADE_BUY", 100n, [[A, 100n]]),
      tx("TRADE_SELL", 110n, [[A, -100n]]),
      tx("TRADE_BUY", 120n, [[A, 100n]]),
      tx("TRADE_SELL", 130n, [[A, -100n]]),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => [s.startBlockL2, s.endBlockL2])).toEqual([
      [99n, 110n],
      [119n, 130n],
    ]);
  });
});
