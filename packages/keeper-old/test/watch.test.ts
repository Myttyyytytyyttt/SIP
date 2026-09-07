// The watermark and the tick plan. Pure functions, no I/O.
//
// The properties that matter: the anchor never advances past a point the wallet
// was not flat — unless the session holding it open is already too wide to ever
// verify, in which case it is abandoned on record — it never moves backwards, it
// never skips a candidate that has not been handled, and a span that is too wide
// produces a refusal rather than a partial scan.

import { describe, expect, it } from "vitest";
import type { DetectedSession, OpenSessionStatus } from "../src/engine.js";
import type { SkipReason } from "../src/ledger.js";
import { planTick, tickScanBounds, verifyRequestFor } from "../src/watch.js";

const session = (start: bigint, end: bigint): DetectedSession => ({
  startBlockL2: start,
  endBlockL2: end,
  tokens: ["0xtoken"],
  buys: 1,
  sells: 1,
  peakConcurrentPositions: 1,
  dust: [],
  airdropsInside: [],
  spanBlocks: end - start,
});

const idle: OpenSessionStatus = { state: "IDLE", startBlockL2: null, openTokens: [] };
const open = (start: bigint): OpenSessionStatus => ({
  state: "OPEN",
  startBlockL2: start,
  openTokens: [{ token: "0xtoken", quantity: 1n }],
});

describe("tickScanBounds", () => {
  it("holds the finality margin back from the head", () => {
    const result = tickScanBounds({
      anchorBlockL2: 1_000n,
      headBlockL2: 1_100n,
      finalityMarginL2: 64n,
      maxTickScanSpanBlocks: 20_000n,
    });
    expect(result.kind).toBe("SCAN");
    if (result.kind === "SCAN") {
      expect(result.bounds.fromBlockL2).toBe(1_000n);
      expect(result.bounds.toBlockL2).toBe(1_036n);
    }
  });

  it("is IDLE when the safe head has not passed the anchor", () => {
    expect(
      tickScanBounds({ anchorBlockL2: 1_050n, headBlockL2: 1_100n, finalityMarginL2: 64n, maxTickScanSpanBlocks: 20_000n }).kind,
    ).toBe("IDLE");
  });

  /**
   * THE ONE THAT MATTERS. This used to assert a refusal, and the refusal made
   * falling behind permanent: the keeper declined to scan, the gap grew every
   * block, and it re-declined forever while its ticks still looked healthy. A
   * real deployment hit exactly that and stopped settling for good.
   *
   * A bounded window is not the truncation the old comment feared. It is a
   * complete answer about less chain — which is what every ordinary tick is.
   */
  it("scans a bounded prefix when far behind, so it can always make progress", () => {
    const result = tickScanBounds({
      anchorBlockL2: 0n,
      headBlockL2: 22_996_865n,
      finalityMarginL2: 64n,
      maxTickScanSpanBlocks: 20_000n,
    });
    expect(result.kind).toBe("SCAN");
    if (result.kind !== "SCAN") return;
    expect(result.bounds.fromBlockL2).toBe(0n);
    expect(result.bounds.toBlockL2).toBe(20_000n);
    // And it says how much chain it did NOT look at, so a quiet tick while
    // catching up cannot be read as "nothing happened".
    expect(result.behindBy).toBe(22_996_801n - 20_000n);
  });

  it("reports nothing outstanding once the whole gap fits in one window", () => {
    const result = tickScanBounds({
      anchorBlockL2: 1_000n,
      headBlockL2: 6_064n,
      finalityMarginL2: 64n,
      maxTickScanSpanBlocks: 20_000n,
    });
    expect(result.kind).toBe("SCAN");
    if (result.kind !== "SCAN") return;
    expect(result.bounds.toBlockL2).toBe(6_000n);
    expect(result.behindBy).toBe(0n);
  });

  it("walks forward one window per tick until it is current", () => {
    // Three ticks over a 50k gap, each starting where the last one stopped.
    let anchor = 0n;
    const head = 50_064n;
    const seen: bigint[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = tickScanBounds({
        anchorBlockL2: anchor,
        headBlockL2: head,
        finalityMarginL2: 64n,
        maxTickScanSpanBlocks: 20_000n,
      });
      if (result.kind !== "SCAN") break;
      seen.push(result.bounds.toBlockL2);
      // The anchor a flat window advances to, per planTick.
      anchor = result.bounds.toBlockL2;
    }
    expect(seen).toEqual([20_000n, 40_000n, 50_000n]);
  });

  it("does not underflow when the head is inside the margin", () => {
    expect(
      tickScanBounds({ anchorBlockL2: 0n, headBlockL2: 10n, finalityMarginL2: 64n, maxTickScanSpanBlocks: 20_000n }).kind,
    ).toBe("IDLE");
  });
});

describe("planTick", () => {
  const empty = new Map<string, SkipReason>();

  it("anchors at the open session's start, never past it", () => {
    // The wallet bought something it has not finished selling, so the last
    // provably-flat point is the block before that first acquisition.
    const plan = planTick({
      sessions: [session(100n, 200n)],
      openStatus: open(300n),
      scannedTo: 1_000n,
      anchorBlockL2: 50n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.nextAnchorL2).toBe(300n);
  });

  it("anchors at the scanned head when the wallet is idle", () => {
    const plan = planTick({
      sessions: [session(100n, 200n)],
      openStatus: idle,
      scannedTo: 1_000n,
      anchorBlockL2: 50n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.nextAnchorL2).toBe(1_000n);
  });

  it("never moves the anchor backwards", () => {
    const plan = planTick({
      sessions: [],
      openStatus: open(10n),
      scannedTo: 1_000n,
      anchorBlockL2: 500n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.nextAnchorL2).toBe(500n);
  });

  it("returns candidates oldest first, which is what keeps progression satisfiable", () => {
    // Settle a later window first and the vault's monotone-progression guard
    // forecloses every earlier one, permanently.
    const plan = planTick({
      sessions: [session(500n, 600n), session(100n, 200n), session(300n, 400n)],
      openStatus: idle,
      scannedTo: 1_000n,
      anchorBlockL2: 0n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.candidates.map((s) => s.endBlockL2)).toEqual([200n, 400n, 600n]);
  });

  it("filters out windows the journal has already finished with", () => {
    const terminal = new Map<string, SkipReason>([["100:200", "REFUSED"]]);
    const plan = planTick({
      sessions: [session(100n, 200n), session(300n, 400n)],
      openStatus: idle,
      scannedTo: 1_000n,
      anchorBlockL2: 0n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: terminal,
    });
    expect(plan.candidates.map((s) => s.startBlockL2)).toEqual([300n]);
    expect(plan.alreadyHandled).toHaveLength(1);
    expect(plan.alreadyHandled[0]?.reason).toContain("REFUSED");
  });

  /**
   * THE LIVELOCK. Pinning the anchor at an open session's start also freezes the
   * scan window at (start, start + maxTickScanSpanBlocks] — so a session whose
   * close lay beyond that edge was re-scanned identically forever. A real
   * account hit exactly this: two positions opened at block 48459015 and held
   * past the window, behindBy grew by a million blocks while ~3,000 RPC calls a
   * tick re-read the same 30k blocks, and every trade the owner made after the
   * open was invisible to the keeper. Once the session is wider than the dense
   * verifier's limit measured to the scan edge, no eventual close can save it —
   * so it is abandoned on record and the anchor moves on.
   */
  it("abandons an open session already too wide to ever verify, so the scan can advance", () => {
    const plan = planTick({
      sessions: [],
      openStatus: open(100n),
      scannedTo: 30_100n,
      anchorBlockL2: 100n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.nextAnchorL2).toBe(30_100n);
    expect(plan.abandonedOpen).toEqual({
      startBlockL2: 100n,
      scannedTo: 30_100n,
      openTokens: ["0xtoken"],
    });
  });

  it("keeps waiting while the open session could still close within the verifier's limit", () => {
    // Exactly at the limit is still verifiable — the closed-session rule is
    // strict (`>`), and this boundary mirrors it.
    const plan = planTick({
      sessions: [],
      openStatus: open(100n),
      scannedTo: 20_100n,
      anchorBlockL2: 100n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.nextAnchorL2).toBe(100n);
    expect(plan.abandonedOpen).toBeNull();
  });

  it("escapes the frozen window: the abandoned anchor unfreezes the next scan", () => {
    // The two halves composed, the way the tick loop runs them. Tick 1 is the
    // livelocked shape; after the abandonment the anchor equals the scan edge,
    // so tick 2's bounds finally move — the property the livelock violated.
    const maxSpan = 30_000n;
    const anchor = 48_459_015n;
    const head = 49_538_349n;
    const tick1 = tickScanBounds({ anchorBlockL2: anchor, headBlockL2: head, finalityMarginL2: 64n, maxTickScanSpanBlocks: maxSpan });
    expect(tick1.kind).toBe("SCAN");
    if (tick1.kind !== "SCAN") return;
    const plan = planTick({
      sessions: [],
      openStatus: open(anchor),
      scannedTo: tick1.bounds.toBlockL2,
      anchorBlockL2: anchor,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.abandonedOpen).not.toBeNull();
    const tick2 = tickScanBounds({
      anchorBlockL2: plan.nextAnchorL2,
      headBlockL2: head,
      finalityMarginL2: 64n,
      maxTickScanSpanBlocks: maxSpan,
    });
    expect(tick2.kind).toBe("SCAN");
    if (tick2.kind !== "SCAN") return;
    expect(tick2.bounds.fromBlockL2).toBe(anchor + maxSpan);
    expect(tick2.bounds.toBlockL2).toBe(anchor + maxSpan * 2n);
  });

  it("separates too-wide sessions instead of splitting or dropping them", () => {
    const plan = planTick({
      sessions: [session(0n, 50_000n), session(60_000n, 60_100n)],
      openStatus: idle,
      scannedTo: 70_000n,
      anchorBlockL2: 0n,
      maxVerifySpanBlocks: 20_000n,
      terminalWindows: empty,
    });
    expect(plan.tooWide.map((s) => s.endBlockL2)).toEqual([50_000n]);
    expect(plan.candidates.map((s) => s.endBlockL2)).toEqual([60_100n]);
  });
});

describe("verifyRequestFor", () => {
  it("attests exactly the detector's boundaries, with replay starting at the window start", () => {
    // Anything later pushes REPLAY_TOO_SHORT; anything hand-adjusted is the thing
    // the engine exists to prevent.
    const request = verifyRequestFor(session(22_080_592n, 22_080_850n));
    expect(request).toEqual({
      startBlockL2: 22_080_592n,
      endBlockL2: 22_080_850n,
      replayStartBlockL2: 22_080_592n,
    });
  });
});
