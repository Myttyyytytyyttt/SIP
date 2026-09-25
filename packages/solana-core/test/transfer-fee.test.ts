// client/transfer-fee.ts over the mints mainnet actually serves.
//
// THE BYTES ARE THE KEEPER'S CAPTURE, read as a third party. The keeper's
// test/fixtures/token2022-mints.json holds real mint accounts read off mainnet
// (ANTHROPIC on 2026-09-21 and again on 2026-09-24, SPYx on 2026-09-21). This
// package may not import the keeper, and a fixture built by a helper written
// beside this decoder would agree with it and with nothing else — the exact
// trap the keeper fell into at offset 82 (docs/TESTING_TRAPS.md, first
// species). So the decoder here is held to the chain's own bytes, and to the
// same numbers the keeper's decodeMintFacts reads out of them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { floorWad } from "../src/client/clmm-price";
import { LEG_FLOOR_MARGIN_BPS, catalogueLegSlippageBps, legFloorMarginBps } from "../src/client/product";
import { TransferFeeReadError, decodeMintTransferFee, feeToNetBps, legFloorWad, netOfTransferFeeWad } from "../src/client/transfer-fee";
import { LEG_FEE } from "./fixtures/keeper-policy";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../solana-keeper/test/fixtures/token2022-mints.json", import.meta.url)), "utf8"),
) as { readonly mints: Record<string, { readonly base64: string }> };
const bytesOf = (name: string): Uint8Array => new Uint8Array(Buffer.from(fixture.mints[name]!.base64, "base64"));
const UNCAPPED = (1n << 64n) - 1n;

describe("a mint's transfer fee, out of its own bytes", () => {
  it("reads ANTHROPIC as mainnet held it on 2026-09-24: 100 from epoch 1039, 300 written for 1043", () => {
    expect(decodeMintTransferFee(bytesOf("ANTHROPIC_2026_09_24"))).toEqual({
      older: { epoch: 1_039n, maximumFee: UNCAPPED, bps: 100 },
      newer: { epoch: 1_043n, maximumFee: UNCAPPED, bps: 300 },
    });
    // And the 2026-09-21 capture, the schedule before that one.
    expect(decodeMintTransferFee(bytesOf("ANTHROPIC"))).toEqual({
      older: { epoch: 1_032n, maximumFee: UNCAPPED, bps: 50 },
      newer: { epoch: 1_039n, maximumFee: UNCAPPED, bps: 100 },
    });
  });

  it("reads SPYx, a 676-byte Token-2022 mint with extensions, as carrying no fee at all — and a classic mint the same", () => {
    expect(bytesOf("SPYx").length).toBe(676);
    expect(decodeMintTransferFee(bytesOf("SPYx"))).toBeNull();
    expect(decodeMintTransferFee(new Uint8Array(82))).toBeNull();
  });

  it("refuses a layout it does not understand rather than reading a fee out of it", () => {
    expect(() => decodeMintTransferFee(new Uint8Array(81))).toThrow(TransferFeeReadError);
    const wrongType = new Uint8Array(200);
    wrongType[165] = 2; // AccountType::Account: a token account, not a mint
    expect(() => decodeMintTransferFee(wrongType)).toThrow(/not the 1 Token-2022 writes for a mint/);
    const truncated = new Uint8Array(170);
    truncated[165] = 1;
    truncated[166] = 1; // TransferFeeConfig…
    truncated[168] = 108; // …108 bytes that are not there
    expect(() => decodeMintTransferFee(truncated)).toThrow(/past the end of a 170-byte mint/);
  });
});

describe("the fee a floor must leave room for", () => {
  const schedule = decodeMintTransferFee(bytesOf("ANTHROPIC_2026_09_24"));

  it("is the WRITTEN 300 from the day it was written, not the 100 still charged", () => {
    // Read in epoch 1041: 100 in force, 300 written for 1043. A floor signed
    // now stands after 1043, so it nets the 300.
    expect(feeToNetBps(schedule, 1_041n)).toBe(300);
    expect(feeToNetBps(schedule, 1_042n)).toBe(300);
    expect(feeToNetBps(schedule, 1_043n)).toBe(300);
    expect(feeToNetBps(schedule, 1_050n)).toBe(300);
    expect(feeToNetBps(null, 1_041n)).toBe(0);
  });

  it("nets a cut only once it has landed: until then the higher, live fee is what a transfer pays", () => {
    const cut = { older: { epoch: 1_039n, maximumFee: UNCAPPED, bps: 300 }, newer: { epoch: 1_043n, maximumFee: UNCAPPED, bps: 100 } };
    expect(feeToNetBps(cut, 1_042n)).toBe(300);
    // From 1043 the 300 is history, and a floor netted of it would give away
    // 2 % of price protection for a fee the mint no longer charges.
    expect(feeToNetBps(cut, 1_043n)).toBe(100);
  });

  it("takes the fee off the rate, rounded down, and refuses a fee that is not one", () => {
    expect(netOfTransferFeeWad(10_000n, 300)).toBe(9_700n);
    expect(netOfTransferFeeWad(9_999n, 300)).toBe(9_699n); // 9699.03 -> down
    expect(netOfTransferFeeWad(123n, 0)).toBe(123n);
    expect(() => netOfTransferFeeWad(1n, 10_001)).toThrow(RangeError);
    expect(() => netOfTransferFeeWad(1n, 1.5)).toThrow(RangeError);
  });

  /**
   * THE REAL NUMBERS, MEASURED 2026-09-24 at slot 450109719 against ANTHROPIC's
   * floor pool (Raydium CLMM 47MsbowA…) and lite-api.jup.ag, $5 in:
   *   pool mid                                   4,783,107 raw (legWad below)
   *   Jupiter, that pool alone (dexes=Raydium CLMM, direct)
   *                                              4,723,099 raw — 125.45 bps under
   *                                              the mid: 25 bps tier + 100 bps fee
   * So the mid is GROSS of the transfer fee.
   *
   * WHAT THE FLOOR HAS TO CLEAR IS THE KEEPER'S min_out, NOT THE CREDIT. The
   * route builder (jupiter-route.ts) takes the quote less legSlippageBps(fee),
   * then less the fee rounded up, and refuses the route [below-owner-floor] when
   * that is under the signed floor. Modelled here for a GROSS-quoting last hop
   * (Manifest, which the live ANTHROPIC route ends on): the quote is the mid
   * less the pool's 25 bps tier, DERIVED from the measurement above, not quoted.
   */
  it("leaves the market about 3 % over the keeper's own min_out at 100 bps and at 300, where a flat 5 % left 0.8 % at 300", () => {
    const legWad = 956_621_484_149_530_048n;
    const amountIn = 5_000_000n;
    const floorOut = (wad: bigint): bigint => (amountIn * wad) / 10n ** 18n;
    expect(floorOut(legWad)).toBe(4_783_107n);
    const grossQuote = (4_783_107n * 9_975n) / 10_000n;
    const keeperMinOut = (feeBps: number): bigint => {
      const slippage = BigInt(catalogueLegSlippageBps(feeBps));
      const threshold = grossQuote - (grossQuote * slippage) / 10_000n;
      return threshold - (threshold * BigInt(feeBps) + 9_999n) / 10_000n;
    };
    const roomBps = (minOut: bigint, floor: bigint): bigint => ((minOut - floor) * 10_000n) / floor;

    expect(keeperMinOut(100)).toBe(4_628_969n);
    expect(keeperMinOut(300)).toBe(4_442_894n);
    // THE RULE: 95 % of the net mid at 100, 93 % of it at 300.
    expect(floorOut(legFloorWad(legWad, 100))).toBe(4_498_512n);
    expect(floorOut(legFloorWad(legWad, 300))).toBe(4_314_841n);
    expect(roomBps(keeperMinOut(100), floorOut(legFloorWad(legWad, 100)))).toBe(290n);
    expect(roomBps(keeperMinOut(300), floorOut(legFloorWad(legWad, 300)))).toBe(296n);

    // WHAT IT REPLACED. A flat 5 % under the NET mid left 79 bps at 300 — for
    // pool fees, impact and a day's drift together — and the 5 % under the
    // GROSS mid the owner's live policy was signed at is 222 bps UNDER it: the
    // [below-owner-floor] refusal the keeper has returned since 300 was written.
    const flatNet = floorOut(floorWad(netOfTransferFeeWad(legWad, 300), LEG_FLOOR_MARGIN_BPS));
    const gross = floorOut(floorWad(legWad, LEG_FLOOR_MARGIN_BPS));
    expect(roomBps(keeperMinOut(300), flatNet)).toBe(79n);
    expect(roomBps(keeperMinOut(300), gross)).toBe(-222n);
  });

  it("widens the margin by exactly what the keeper widens its ask by, through the shared vector", () => {
    // legSlippageBps(fee) = max(slippageBps, fee + slippageMarginBps): the
    // keeper's arithmetic, out of the vector its own tests hold it to.
    const keeperAsk = (fee: bigint): bigint => (LEG_FEE.slippageBps > fee + LEG_FEE.slippageMarginBps ? LEG_FEE.slippageBps : fee + LEG_FEE.slippageMarginBps);
    for (const fee of [0n, 50n, 100n, 101n, 150n, 250n, LEG_FEE.keeper.value]) {
      expect(BigInt(legFloorMarginBps(Number(fee))), `margin at ${fee} bps`).toBe(BigInt(LEG_FLOOR_MARGIN_BPS) + keeperAsk(fee) - LEG_FEE.slippageBps);
    }
    // Worked by hand: nothing extra up to 100, 200 bps extra at the ceiling.
    expect([0, 100, 150, 300].map(legFloorMarginBps)).toEqual([500, 500, 550, 700]);
    expect(legFloorWad(10n ** 18n, 300)).toBe(902_100_000_000_000_000n); // 0.97 x 0.93
    expect(legFloorWad(10n ** 18n, 0)).toBe(950_000_000_000_000_000n);
  });
});
