// THE SHARE CARD'S PLATES (owner, 10-22): the films' three backgrounds, in the
// picker's order, each URL at its file's version, each plate in the shape the
// video export leans on. The build asks the same before every deploy
// (scripts/check-share-plates.mts, `pnpm run check:plates`); here, through
// plateProblems(), so a stale plate fails the tests too.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SHARE_BACKGROUNDS, SHARE_CARD } from "@/lib/live-share";
import { PLATE_SIZE, SHARE_PLATES, SHARE_VIDEO_LOOPS, STILL_SIZE, THUMB_SIZE, videoSeconds } from "@/lib/share-plates";

import { plateProblems, webpSize } from "../../scripts/check-share-plates.mts";

const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));

describe("the plates", () => {
  it("can ship: every file in public/ at its version, one keyframe a loop, the registry's frame counts", () => {
    expect(plateProblems()).toEqual([]);
  });

  it("one per background, in the picker's order — Grid first", () => {
    expect(Object.keys(SHARE_PLATES)).toEqual([...SHARE_BACKGROUNDS]);
  });

  it("are the card at 1×, and their still the card at 2× (SHARE_SCALE)", () => {
    expect(PLATE_SIZE).toEqual(SHARE_CARD);
    expect(STILL_SIZE).toEqual({ width: SHARE_CARD.width * 2, height: SHARE_CARD.height * 2 });
    expect(THUMB_SIZE.width / THUMB_SIZE.height).toBeCloseTo(SHARE_CARD.width / SHARE_CARD.height, 5);
  });

  it("every URL is under /share/ and carries an 8-hex version — the only kind next.config.mjs caches for a year", () => {
    for (const plate of Object.values(SHARE_PLATES)) {
      for (const url of [plate.mp4, plate.webm, plate.still, plate.thumb]) expect(url).toMatch(/^\/share\/[a-z]+(-thumb)?\.(mp4|webm|webp)\?v=[0-9a-f]{8}$/);
    }
  });

  it("the video is two loops: 12 s of Grid, 10 s of the others", () => {
    expect(SHARE_VIDEO_LOOPS).toBe(2);
    expect(Object.values(SHARE_PLATES).map(videoSeconds)).toEqual([12, 10, 10]);
  });
});

describe("a WebP's size, from its header", () => {
  const riff = (chunk: string, body: number[]): Uint8Array => Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk), 0, 0, 0, 0, ...body, ...new Array<number>(16).fill(0)]);

  it("lossy (VP8), lossless (VP8L) and extended (VP8X)", () => {
    // VP8: a frame tag, the start code, then 14-bit width and height.
    expect(webpSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x60, 0x09, 0xec, 0x04]))).toEqual({ width: 2400, height: 1260 });
    // VP8L: the signature, then width−1 and height−1 in 14 bits each.
    const bits = (600 - 1) | ((315 - 1) << 14);
    expect(webpSize(riff("VP8L", [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]))).toEqual({ width: 600, height: 315 });
    // VP8X: flags, reserved, then width−1 and height−1 in 24 bits each.
    expect(webpSize(riff("VP8X", [0, 0, 0, 0, 0x5f, 0x09, 0, 0xeb, 0x04, 0]))).toEqual({ width: 2400, height: 1260 });
    expect(webpSize(Uint8Array.from(Buffer.from("not a webp, not at all, no")))).toBeNull();
  });

  it("the shipped still and thumb", () => {
    const [still, thumb] = [SHARE_PLATES.grid.still, SHARE_PLATES.grid.thumb].map((url) => readFileSync(join(PUBLIC, url.split("?")[0]!)));
    expect(webpSize(still!)).toEqual(STILL_SIZE);
    expect(webpSize(thumb!)).toEqual(THUMB_SIZE);
  });
});
