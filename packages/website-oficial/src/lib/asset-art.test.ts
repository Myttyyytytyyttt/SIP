// ARTWORK IS KEYED BY THE MINT, NOT BY THE TICKER.
//
// A symbol belongs to whoever issued the token. Two mints can carry the same
// one and an issuer can change theirs, so `/stocks/${symbol}.png` would hang
// one issuer's logo on another's mint the first time two of them agree on
// three letters — on a panel reading mainnet that is a question of when.
//
// And a mint with no art must fall through to the lettered disc rather than to
// a broken image: that is what lets a leg be listed the day the policy names
// it, with the artwork following whenever it follows.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { CATALOGUE, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { MINTS_WITHOUT_ART, NATIVE_SOL, artForMint } from "@/lib/asset-art";

const PUBLIC = join(import.meta.dirname, "../../public");

describe("the mark an asset draws", () => {
  it("answers by mint, and answers nothing for a mint it has no file for", () => {
    const spyx = CATALOGUE.find((asset) => asset.symbol === "SPYx");
    expect(spyx).toBeDefined();
    expect(artForMint(spyx!.mint)).toBe("/stocks/SPYx.png");
    expect(artForMint("NotAMintP1aceho1der1111111111111111111111")).toBeNull();
  });

  it("answers nothing rather than throwing when there is no mint at all", () => {
    // The SOL row has no mint, and a null must reach the lettered disc.
    expect(artForMint(null)).toBeNull();
    expect(artForMint(undefined)).toBeNull();
  });

  /**
   * A PATH HERE IS A PROMISE. next/image draws a broken image for a file that
   * is not there — it does not fall back — so a mint may only be mapped once
   * its art is in public/.
   */
  it("promises no file it does not have", () => {
    for (const asset of CATALOGUE) {
      const src = artForMint(asset.mint);
      if (src === null) continue;
      expect(existsSync(join(PUBLIC, src)), `${asset.symbol} -> ${src}`).toBe(true);
    }
  });

  /**
   * The list of what is still wanted, so it is a fact a test states rather than
   * something a person has to remember. Shrinking it is the point; it must
   * never grow silently, and a mint that gains art must leave it.
   */
  it("names exactly what is still without a mark", () => {
    expect([...MINTS_WITHOUT_ART].sort()).toEqual(
      [NATIVE_SOL, WSOL_MINT, USDC_MINT, ...CATALOGUE.filter((asset) => asset.group === "prestock").map((asset) => asset.mint)].sort(),
    );
    // Every catalogue leg that is NOT in that list can be drawn.
    for (const asset of CATALOGUE) {
      if (MINTS_WITHOUT_ART.includes(asset.mint)) continue;
      expect(artForMint(asset.mint), asset.symbol).not.toBeNull();
    }
  });
});
