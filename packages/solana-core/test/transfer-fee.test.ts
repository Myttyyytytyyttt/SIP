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
import { TransferFeeReadError, decodeMintTransferFee, netOfTransferFeeWad, worstCaseFeeBps } from "../src/client/transfer-fee";

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
    expect(worstCaseFeeBps(schedule, 1_041n)).toBe(300);
    expect(worstCaseFeeBps(schedule, 1_042n)).toBe(300);
    expect(worstCaseFeeBps(schedule, 1_043n)).toBe(300);
    expect(worstCaseFeeBps(schedule, 1_050n)).toBe(300);
    expect(worstCaseFeeBps(null, 1_041n)).toBe(0);
  });

  it("nets a cut only once it has landed: until then the higher, live fee is what a transfer pays", () => {
    const cut = { older: { epoch: 1_039n, maximumFee: UNCAPPED, bps: 300 }, newer: { epoch: 1_043n, maximumFee: UNCAPPED, bps: 100 } };
    expect(worstCaseFeeBps(cut, 1_042n)).toBe(300);
    // From 1043 the 300 is history, and a floor netted of it would give away
    // 2 % of price protection for a fee the mint no longer charges.
    expect(worstCaseFeeBps(cut, 1_043n)).toBe(100);
  });

  it("takes the fee off the rate, rounded down, and refuses a fee that is not one", () => {
    expect(netOfTransferFeeWad(10_000n, 300)).toBe(9_700n);
    expect(netOfTransferFeeWad(9_999n, 300)).toBe(9_699n); // 9699.03 -> down
    expect(netOfTransferFeeWad(123n, 0)).toBe(123n);
    expect(() => netOfTransferFeeWad(1n, 10_001)).toThrow(RangeError);
    expect(() => netOfTransferFeeWad(1n, 1.5)).toThrow(RangeError);
  });
});
