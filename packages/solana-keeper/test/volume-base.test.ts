// The volume keeper's base (src/volume-base.ts) and how baseDecision takes it:
// the policy boundary, the cadence, and the prefix that never waits.

import { describe, expect, it } from "vitest";
import type { VolumeTrade, WindowMeasurement } from "../src/measure-window.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import { baseDecision, keeperModes, modeDecision } from "../src/settle-decision.js";
import { VOLUME_MAX_WAIT_SECONDS, VOLUME_MIN_OWED_LAMPORTS, createVolumeBase } from "../src/volume-base.js";

const NOW = 1_790_180_700;
const trade = (slot: number, lamports: bigint, blockTime: number | null = NOW - 60): VolumeTrade => ({
  signature: `sig-${slot}`,
  slot: BigInt(slot),
  blockTime,
  lamports,
});

const span = (volumeTrades: readonly VolumeTrade[] | undefined, over: Partial<WindowMeasurement> = {}): WindowMeasurement => ({
  txCount: 5,
  settleTxCount: 0,
  walletSignedTxCount: 5,
  successfulTradeCount: volumeTrades?.length ?? 0,
  tradedLamports: 0n,
  chainBreaks: 0,
  unfetchable: 0,
  cashDelta: 0n,
  deposits: 0n,
  withdrawals: 0n,
  profitLamports: 0n,
  firstSlot: 101n,
  lastSlot: 200n,
  signaturesAbove: 5,
  frontierReached: true,
  pagesExhausted: false,
  prefixCut: false,
  ...(volumeTrades === undefined ? {} : { volumeTrades }),
  ...over,
});

const base = (volumeBps: number, boundarySlot: bigint | null = null) =>
  createVolumeBase({ volumeBps, boundary: async () => ({ slot: boundarySlot, detail: "test" }), nowSeconds: () => NOW });

describe("createVolumeBase", () => {
  it("charges the sum of every counted trade once it owes the minimum", async () => {
    // 50 000 000 at 200 bps owes 1 000 000: exactly the minimum.
    expect(await base(200)(span([trade(150, 30_000_000n), trade(160, 20_000_000n)]))).toBe(50_000_000n);
  });

  it("waits while the span owes less than 0.001 SOL and its oldest trade is under an hour old", async () => {
    const answer = await base(200)(span([trade(150, 49_999_999n)]));
    expect(answer).toMatchObject({ waitLamports: 49_999_999n });
    expect(VOLUME_MIN_OWED_LAMPORTS).toBe(1_000_000n);
  });

  it("stops waiting an hour after the oldest trade", async () => {
    expect(await base(200)(span([trade(150, 1_000n, NOW - VOLUME_MAX_WAIT_SECONDS)]))).toBe(1_000n);
    expect(await base(200)(span([trade(150, 1_000n, NOW - VOLUME_MAX_WAIT_SECONDS + 1)]))).toMatchObject({ waitLamports: 1_000n });
  });

  it("does not make a trade with no block time wait", async () => {
    expect(await base(200)(span([trade(150, 1_000n, null)]))).toBe(1_000n);
  });

  it("forgives every trade at or before the policy boundary", async () => {
    const trades = [trade(150, 900_000_000n), trade(170, 100_000_000n), trade(180, 50_000_000n)];
    expect(await base(200, 170n)(span(trades))).toBe(50_000_000n);
    expect(await base(200, 180n)(span(trades))).toBe(0n);
    expect(await base(200, null)(span(trades))).toBe(1_050_000_000n);
  });

  it("does not ask for the boundary when nothing traded", async () => {
    const asked: string[] = [];
    const seam = createVolumeBase({ volumeBps: 200, boundary: async () => (asked.push("asked"), { slot: null, detail: "" }), nowSeconds: () => NOW });
    expect(await seam(span([]))).toBe(0n);
    expect(asked).toEqual([]);
  });

  it("throws on a walk that was not given the probe, instead of reading it as no volume", async () => {
    await expect(base(200)(span(undefined))).rejects.toThrow(/volume probe/);
  });
});

describe("baseDecision on the volume keeper's base", () => {
  const from = 100n;
  const decide = (measured: WindowMeasurement, bps = 200, boundary: bigint | null = null) =>
    baseDecision({ mode: MODE_VOLUME, measured, from, volumeBase: base(bps, boundary), carry: null });

  it("settles a span that owes the minimum over the whole window", async () => {
    expect(await decide(span([trade(150, 50_000_000n)]))).toEqual({ kind: "settle", baseLamports: 50_000_000n, endSlot: 200n });
  });

  it("rests a span under the minimum at NO_PROFIT, naming what it owes", async () => {
    const decision = await decide(span([trade(150, 1_000_000n)]));
    expect(decision).toMatchObject({ kind: "stop", outcome: "NO_PROFIT", baseLamports: 1_000_000n });
    expect(decision.kind === "stop" && decision.detail).toMatch(/owe 20000 at 200 bps/);
  });

  it("never makes a prefix wait: a cut backlog settles what it traded", async () => {
    expect(await decide(span([trade(150, 1_000_000n)], { prefixCut: true, signaturesAbove: 400 }))).toMatchObject({
      kind: "settle",
      baseLamports: 1_000_000n,
    });
  });

  it("settles nothing for trades the boundary forgave, until the wallet has signed enough to zero-settle", async () => {
    const decision = await decide(span([trade(150, 900_000_000n)]), 200, 160n);
    expect(decision).toMatchObject({ kind: "stop", outcome: "NO_PROFIT", baseLamports: 0n });
  });
});

describe("one keeper per mode", () => {
  it("the profit keeper settles PROFIT vaults, the volume keeper VOLUME ones, and neither both", () => {
    expect(keeperModes("profit")).toEqual([MODE_PROFIT]);
    expect(keeperModes("volume")).toEqual([MODE_VOLUME]);
  });

  it("a vault of the other mode rests before anything is measured", () => {
    expect(modeDecision({ skimMode: MODE_VOLUME }, keeperModes("profit"))).toMatchObject({ outcome: "UNSUPPORTED_MODE", detail: expect.stringMatching(/volume keeper settles/) });
    expect(modeDecision({ skimMode: MODE_PROFIT }, keeperModes("volume"))).toMatchObject({ outcome: "UNSUPPORTED_MODE", detail: expect.stringMatching(/profit keeper settles/) });
    expect(modeDecision({ skimMode: MODE_PROFIT }, keeperModes("profit"))).toBeNull();
    expect(modeDecision({ skimMode: MODE_VOLUME }, keeperModes("volume"))).toBeNull();
  });

  it("an undefined mode still stops every keeper", () => {
    for (const role of ["profit", "volume"] as const) {
      expect(modeDecision({ skimMode: 7 }, keeperModes(role))).toMatchObject({ outcome: "UNSUPPORTED_MODE", detail: expect.stringMatching(/no sip-vault version defines/) });
    }
  });
});

