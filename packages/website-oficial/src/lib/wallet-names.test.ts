// A wallet's own name (owner, 10-23): what the box and /api/wallet-names both accept, and what finishing an
// edit decides — the rules the server enforces are the ones the input applies, so they are tested once, here.

import { describe, expect, it } from "vitest";

import { WALLET_NAME_COPY, WALLET_NAME_MAX_CHARS, cleanWalletName, namesFrom, renameOutcome } from "@/lib/wallet-names";

const WALLET = "TradingZeroP1aceho1der11111111111111111111";

describe("cleanWalletName", () => {
  it("trims, and keeps what was typed otherwise", () => {
    expect(cleanWalletName("  Axiom main  ")).toEqual({ ok: true, name: "Axiom main" });
    expect(cleanWalletName("Ahorro · día 1")).toEqual({ ok: true, name: "Ahorro · día 1" });
  });

  it("reads empty, or only spaces, as back to the default name", () => {
    expect(cleanWalletName("")).toEqual({ ok: true, name: null });
    expect(cleanWalletName("   ")).toEqual({ ok: true, name: null });
  });

  it("normalizes to NFC, so the same name typed two ways is one name", () => {
    expect(cleanWalletName("Cafe\u0301")).toEqual({ ok: true, name: "Caf\u00E9" });
  });

  it("allows exactly the maximum, in characters rather than UTF-16 units", () => {
    expect(cleanWalletName("a".repeat(WALLET_NAME_MAX_CHARS))).toEqual({ ok: true, name: "a".repeat(WALLET_NAME_MAX_CHARS) });
    expect(cleanWalletName("a".repeat(WALLET_NAME_MAX_CHARS + 1))).toEqual({ ok: false, message: WALLET_NAME_COPY.tooLong });
    // 32 emoji are 64 UTF-16 units and 32 characters.
    expect(cleanWalletName("💰".repeat(WALLET_NAME_MAX_CHARS)).ok).toBe(true);
  });

  it("refuses line breaks, control characters and the invisible ones that turn text around", () => {
    for (const bad of ["a\nb", "a\tb", "a\u0000b", "a\u202Eb", "a\u2066b", "a\u200Bb", "a\uFEFFb", "a\u2028b"]) {
      expect(cleanWalletName(bad)).toEqual({ ok: false, message: WALLET_NAME_COPY.forbidden });
    }
  });

  it("keeps the joiners emoji sequences need", () => {
    expect(cleanWalletName("👨\u200D👩\u200D👧 fund").ok).toBe(true);
  });
});

describe("renameOutcome", () => {
  it("saves a new name", () => {
    expect(renameOutcome("Axiom", "Trading wallet 1", null)).toEqual({ kind: "save", name: "Axiom" });
    expect(renameOutcome("  Axiom 2 ", "Axiom", "Axiom")).toEqual({ kind: "save", name: "Axiom 2" });
  });

  it("changes nothing for the same text, typed or untouched", () => {
    expect(renameOutcome("Trading wallet 1", "Trading wallet 1", null)).toEqual({ kind: "unchanged" });
    expect(renameOutcome("Axiom", "Axiom", "Axiom")).toEqual({ kind: "unchanged" });
    expect(renameOutcome(" Axiom ", "Axiom", "Axiom")).toEqual({ kind: "unchanged" });
  });

  it("empty goes back to the default — and only when there is a name to clear", () => {
    expect(renameOutcome("", "Axiom", "Axiom")).toEqual({ kind: "save", name: null });
    expect(renameOutcome("   ", "Trading wallet 1", null)).toEqual({ kind: "unchanged" });
  });

  it("refuses a name the server would refuse, with its words", () => {
    expect(renameOutcome("a\nb", "Trading wallet 1", null)).toEqual({ kind: "invalid", message: WALLET_NAME_COPY.forbidden });
  });
});

describe("namesFrom", () => {
  it("keeps address → valid name entries only", () => {
    expect(namesFrom({ [WALLET]: " Axiom ", short: "x", [`${WALLET.slice(0, 40)}OO`]: "o", Other1111111111111111111111111111111111: 7 })).toEqual({ [WALLET]: "Axiom" });
    expect(namesFrom({ [WALLET]: "a\nb" })).toEqual({});
  });

  it("reads anything that is not an object as no names", () => {
    for (const value of [null, undefined, "names", 3, [WALLET]]) expect(namesFrom(value)).toEqual({});
  });
});
