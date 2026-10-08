// A trading wallet's name, the same on the Wallets tab and the live dashboard: created ones counted among
// themselves, imported ones after them — never by Privy's index, which is 0 for an imported wallet too.

import { describe, expect, it } from "vitest";

import { tradingWalletLabels } from "@/lib/wallet-labels";

const created = (address: string) => ({ address, imported: false });
const imported = (address: string) => ({ address, imported: true });

describe("tradingWalletLabels", () => {
  it("counts created wallets in the order given, and names a lone imported one without a number", () => {
    expect([...tradingWalletLabels([created("A"), created("B"), imported("C")])]).toStrictEqual([
      ["A", "Trading wallet 1"],
      ["B", "Trading wallet 2"],
      ["C", "Imported wallet"],
    ]);
  });

  it("numbers imported wallets among themselves when there are several, wherever they stand in the list", () => {
    expect([...tradingWalletLabels([imported("X"), created("A"), imported("Y")])]).toStrictEqual([
      ["X", "Imported wallet 1"],
      ["A", "Trading wallet 1"],
      ["Y", "Imported wallet 2"],
    ]);
  });

  it("gives an account of imported wallets only no 'Trading wallet' name at all, and names a repeated address once", () => {
    expect(tradingWalletLabels([imported("X")]).get("X")).toBe("Imported wallet");
    expect([...tradingWalletLabels([created("A"), created("A")])]).toStrictEqual([["A", "Trading wallet 1"]]);
    expect(tradingWalletLabels([]).size).toBe(0);
  });
});
