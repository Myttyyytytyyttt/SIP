/**
 * THE SHARE CARD'S PLATES, CHECKED BEFORE A BUILD SHIPS THEM.
 *
 * Run: pnpm run check:plates   (prebuild runs it, like check:clips, so a deploy enforces it)
 *
 * WHY BEFORE THE BUILD. Two things about these files fail where nobody looks:
 *   * A /share/ URL is cached for a year without asking again (next.config.mjs),
 *     so a plate changed under the same address never reaches a browser that
 *     has the old one. Each URL carries its file's version (?v=,
 *     src/lib/share-plates.ts), and a stale one is invisible on the page.
 *   * The video export (live/share-video.ts) leans on the plates' shape: it
 *     decodes exactly `frames` frames from the one keyframe at frame 0, and
 *     writes the loop it encoded twice. A plate re-rendered with a second
 *     keyframe, another frame count or another rate would still play in the
 *     preview — and make a video with a stutter or a jump at its seam.
 * So the build reads every plate with the same reader the browser uses
 * (src/lib/share-mp4.ts). share-plates.test.ts asks the same through plateProblems().
 *
 * WHAT IS CHECKED, for each plate in SHARE_PLATES:
 *   * all four files are in public/, each URL at ?v=<the first 8 hex of its sha256>;
 *   * the MP4: one avc1 track, 1200×630, the registry's codec and frame count,
 *     every frame 1/30 s, and exactly one sync sample — the first, frame 0;
 *   * the WebM is a WebM (its EBML header);
 *   * the still is 2400×1260 and the thumb 600×315 (read from the WebP's header);
 *   * the link preview's copy of frame 0 (assets/share-og/plates/<name>.jpg,
 *     components/share-og.tsx) is a JPEG at the card's 1200×630.
 *
 * TO FIX A FAILURE: `pnpm run share:plates --from <checkout>/launch-video/out/share`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMp4 } from "../src/lib/share-mp4.ts";
import { PLATE_SIZE, SHARE_FPS, SHARE_PLATES, STILL_SIZE, THUMB_SIZE } from "../src/lib/share-plates.ts";
import { versionOf } from "./check-clips.mts";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
/** The link preview's plates: frame 0 at 1200×630, read at run time by the server (components/share-og.tsx). */
const OG_PLATES = fileURLToPath(new URL("../assets/share-og/plates/", import.meta.url));

/** A JPEG's size, from its first start-of-frame marker. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { width: (bytes[at + 7]! << 8) | bytes[at + 8]!, height: (bytes[at + 5]! << 8) | bytes[at + 6]! };
    at += 2 + length;
  }
  return null;
}

/** A WebP's canvas size, from its RIFF header: lossy (VP8), lossless (VP8L) or extended (VP8X). */
export function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const text = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length < 30 || text(0, 4) !== "RIFF" || text(8, 4) !== "WEBP") return null;
  const le16 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
  const le24 = (at: number): number => le16(at) | (bytes[at + 2]! << 16);
  switch (text(12, 4)) {
    case "VP8 ":
      return bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a ? { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff } : null;
    case "VP8L": {
      if (bytes[20] !== 0x2f) return null;
      const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      return { width: le24(24) + 1, height: le24(27) + 1 };
    default:
      return null;
  }
}

/** Every way the plates disagree with SHARE_PLATES or with their rules, one line each; [] when they can ship. */
export function plateProblems(): string[] {
  const problems: string[] = [];
  for (const [name, plate] of Object.entries(SHARE_PLATES)) {
    const say = (problem: string): void => {
      problems.push(`${name}: ${problem}`);
    };
    const files: Record<string, Uint8Array> = {};
    for (const [kind, url] of Object.entries({ mp4: plate.mp4, webm: plate.webm, still: plate.still, thumb: plate.thumb })) {
      const [path = ""] = url.split("?");
      if (!path.startsWith("/share/")) {
        say(`${url} is outside /share/`);
      } else if (!existsSync(join(PUBLIC, path))) {
        say(`public${path} is missing`);
      } else {
        const wanted = `${path}?v=${versionOf(path)}`;
        if (url !== wanted) say(`${url} should be ${wanted} (the file changed since its version was written)`);
        files[kind] = readFileSync(join(PUBLIC, path));
      }
    }

    if (files.mp4 !== undefined) {
      try {
        const mp4 = parseMp4(files.mp4);
        if (mp4.width !== PLATE_SIZE.width || mp4.height !== PLATE_SIZE.height) say(`the MP4 is ${mp4.width}×${mp4.height}, not ${PLATE_SIZE.width}×${PLATE_SIZE.height}`);
        if (mp4.codec !== plate.codec) say(`the MP4 is ${mp4.codec}, where SHARE_PLATES says ${plate.codec}`);
        if (mp4.frames !== plate.frames) say(`the MP4 has ${mp4.frames} frames, where SHARE_PLATES says ${plate.frames}`);
        const keys = mp4.samples.flatMap((sample, i) => (sample.key ? [i] : []));
        if (keys.length !== 1 || keys[0] !== 0 || mp4.samples[0]?.frame !== 0) say(`the MP4's sync samples are [${keys.join(", ")}]: a plate has one, the first, at frame 0`);
        const step = mp4.timescale / SHARE_FPS;
        if (!mp4.samples.every((sample, i) => sample.dts === i * step)) say(`the MP4's frames are not all 1/${SHARE_FPS} s`);
      } catch (error) {
        say(`the MP4 does not read: ${(error as Error).message}`);
      }
    }
    if (files.webm !== undefined && !(files.webm[0] === 0x1a && files.webm[1] === 0x45 && files.webm[2] === 0xdf && files.webm[3] === 0xa3)) say("the WebM has no EBML header");
    for (const [kind, size] of [
      ["still", STILL_SIZE],
      ["thumb", THUMB_SIZE],
    ] as const) {
      const bytes = files[kind];
      if (bytes === undefined) continue;
      const got = webpSize(bytes);
      if (got === null) say(`the ${kind} is not a WebP`);
      else if (got.width !== size.width || got.height !== size.height) say(`the ${kind} is ${got.width}×${got.height}, not ${size.width}×${size.height}`);
    }
    const og = join(OG_PLATES, `${name}.jpg`);
    if (!existsSync(og)) say(`assets/share-og/plates/${name}.jpg is missing: the link preview has no background`);
    else {
      const got = jpegSize(readFileSync(og));
      if (got === null) say(`assets/share-og/plates/${name}.jpg is not a JPEG`);
      else if (got.width !== PLATE_SIZE.width || got.height !== PLATE_SIZE.height) say(`assets/share-og/plates/${name}.jpg is ${got.width}×${got.height}, not ${PLATE_SIZE.width}×${PLATE_SIZE.height}`);
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("[web] the share card's plates");
  const problems = plateProblems();
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  if (problems.length === 0) console.log(`  ok    ${Object.keys(SHARE_PLATES).length} plates: every file in public/ at its version, one keyframe a loop, the registry's frame counts, and the link preview's frame 0`);
  console.log(problems.length === 0 ? "[web] plates check passed\n" : `[web] plates check: ${problems.length} FAILED\n`);
  if (problems.length > 0) process.exit(1);
}
