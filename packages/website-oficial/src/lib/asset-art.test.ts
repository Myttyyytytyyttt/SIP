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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CATALOGUE, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { MINTS_WITHOUT_ART, NATIVE_SOL, artForMint, issuerBadgeFor } from "@/lib/asset-art";

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
  it("has a mark for everything it can draw: the list of what is missing is empty", () => {
    expect(MINTS_WITHOUT_ART).toEqual([]);
    // Every catalogue leg that is NOT in that list can be drawn.
    for (const asset of CATALOGUE) {
      if (MINTS_WITHOUT_ART.includes(asset.mint)) continue;
      expect(artForMint(asset.mint), asset.symbol).not.toBeNull();
    }
  });
});

/**
 * WHAT A MARK HAS TO BE, checked against the file rather than against whoever
 * exported it.
 *
 * These are drawn at 16 to 20 px inside `rounded-full`. A file that is not
 * square is scaled to a square by next/image and comes out squashed; a file
 * with opaque corners keeps them, and the circle then crops a coloured box
 * rather than a logo — which is fine for a mark that IS a coloured disc and
 * wrong for one sitting on white. USDC's file arrived 655x468 and fully
 * opaque, and this is the test that keeps it off the page until it is square
 * and transparent.
 */
describe("every mark this app promises to draw", () => {
  /** A PNG's width and height, from its IHDR. No dependency, no decoder. */
  function header(file: string): { width: number; height: number } {
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 8).toString("hex"), `${file} is not a PNG`).toBe("89504e470d0a1a0a");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  const mapped = (): readonly { readonly mint: string; readonly src: string }[] =>
    [NATIVE_SOL, WSOL_MINT, USDC_MINT, ...CATALOGUE.map((asset) => asset.mint)]
      .map((mint) => ({ mint, src: artForMint(mint) }))
      .filter((entry): entry is { mint: string; src: string } => entry.src !== null);

  it("is square, so a 20px circle does not squash it", () => {
    for (const { src } of mapped()) {
      const { width, height } = header(join(PUBLIC, src));
      expect(width, `${src} is ${width}x${height}`).toBe(height);
    }
  });

  it("is a PNG at every path the badges point at too", () => {
    for (const group of ["prestock", "xstock"]) {
      const badge = issuerBadgeFor(CATALOGUE.find((asset) => asset.group === group)!.mint);
      expect(badge, group).not.toBeNull();
      const { width, height } = header(join(PUBLIC, badge!.src));
      expect(width, `${badge!.src} is ${width}x${height}`).toBe(height);
    }
  });

  /*
   * WHAT THIS FILE CANNOT CHECK, so that nobody reads its silence as a pass:
   * whether the mark FILLS its frame. A logo inset in a white square is clipped
   * to a white ring with something small in the middle, which is what USDC's
   * first two files did — the first was also 655x468 and the square check above
   * caught that one. Node ships no PNG decoder, and hand-rolling one here
   * (palette, interlacing, per-scanline filters) would be a bug farm guarding a
   * property a human sees in one glance. Look at a new mark before mapping it.
   */
});
