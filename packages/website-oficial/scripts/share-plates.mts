/**
 * THE SHARE CARD'S PLATES, READY TO SERVE: the films' three animated
 * backgrounds in public/share/, each with its still and its thumb, and every
 * file's version written into src/lib/share-plates.ts.
 *
 * Run from packages/website-oficial (needs cwebp and ffmpeg: `brew install webp ffmpeg`):
 *
 *   pnpm run share:plates --from <checkout>/launch-video/out/share
 *
 * --from is the films' output folder (launch-video/ is read, never written: it
 * belongs to the films), holding <name>.mp4, <name>.webm and <name>.png — the
 * PNG being the plate's frame 0 at 2400×1260 — for grid, streaks and vault.
 *
 * WHAT IT DOES, per plate:
 *   * copies the MP4 and the WebM as they are: no re-encode, which would cost a
 *     generation of quality and could break the plates' one-keyframe rule;
 *   * makes the still (<name>.webp, 2400×1260) and the thumb (<name>-thumb.webp,
 *     600×315) from the PNG, in WebP at q88 (src/lib/share-plates.ts says why);
 *   * makes the link preview's frame 0 (assets/share-og/plates/<name>.jpg,
 *     1200×630, JPEG at -q:v 2 in 4:4:4: 54–56 dB from the PNG at ~40 KB), which
 *     the server draws the card on (components/share-og.tsx) — then
 *     SHARE_RENDER_VERSION changes, and `pnpm run check:render` says to what;
 *   * reads the MP4 back (src/lib/share-mp4.ts) for its frame count and codec;
 *   * rewrites its plateFiles(...) line with the four versions.
 * Then `pnpm run check:plates` says whether they can ship, and
 * `pnpm run check:render` the link preview's new version.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMp4 } from "../src/lib/share-mp4.ts";
import { PLATE_SIZE, STILL_SIZE, THUMB_SIZE } from "../src/lib/share-plates.ts";
import { versionOf } from "./check-clips.mts";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC = join(PACKAGE, "public");
const OG_PLATES = join(PACKAGE, "assets/share-og/plates");
const PLATES_TS = join(PACKAGE, "src/lib/share-plates.ts");
const NAMES = ["grid", "streaks", "vault"] as const;

/** The docs' poster setting (scripts/docs-clip.mts): q88 with sharp RGB→YUV, no banding in the dark gradients. */
const CWEBP = ["-quiet", "-q", "88", "-m", "6", "-sharp_yuv", "-af"];

function fail(message: string): never {
  console.error(`share:plates: ${message}`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: ["ignore", "ignore", "inherit"] });
  if (result.error !== undefined) fail(`${command} did not run (${result.error.message}); brew install webp ffmpeg`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
}

/** A PNG's size, from its IHDR. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.toString("latin1", 12, 16) !== "IHDR") fail(`${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const args = process.argv.slice(2);
const fromAt = args.indexOf("--from");
const from = fromAt === -1 ? null : (args[fromAt + 1] ?? "");
if (from === null || !existsSync(from)) fail("--from needs the films' output folder: pnpm run share:plates --from <checkout>/launch-video/out/share");

mkdirSync(join(PUBLIC, "share"), { recursive: true });
mkdirSync(OG_PLATES, { recursive: true });
let source = readFileSync(PLATES_TS, "utf8");

for (const name of NAMES) {
  for (const kind of ["mp4", "webm", "png"]) if (!existsSync(join(from, `${name}.${kind}`))) fail(`${from}/${name}.${kind} is missing`);
  const png = join(from, `${name}.png`);
  const size = pngSize(png);
  if (size.width !== STILL_SIZE.width || size.height !== STILL_SIZE.height) fail(`${name}.png is ${size.width}×${size.height}, not ${STILL_SIZE.width}×${STILL_SIZE.height}`);

  const files = { mp4: `/share/${name}.mp4`, webm: `/share/${name}.webm`, still: `/share/${name}.webp`, thumb: `/share/${name}-thumb.webp` };
  copyFileSync(join(from, `${name}.mp4`), join(PUBLIC, files.mp4));
  copyFileSync(join(from, `${name}.webm`), join(PUBLIC, files.webm));
  run("cwebp", [...CWEBP, png, "-o", join(PUBLIC, files.still)]);
  run("cwebp", [...CWEBP, "-resize", String(THUMB_SIZE.width), String(THUMB_SIZE.height), png, "-o", join(PUBLIC, files.thumb)]);
  run("ffmpeg", ["-v", "error", "-y", "-i", png, "-vf", `scale=${PLATE_SIZE.width}:${PLATE_SIZE.height}:flags=lanczos,format=yuvj444p`, "-q:v", "2", join(OG_PLATES, `${name}.jpg`)]);

  const mp4 = parseMp4(readFileSync(join(PUBLIC, files.mp4)));
  const v = { mp4: versionOf(files.mp4), webm: versionOf(files.webm), still: versionOf(files.still), thumb: versionOf(files.thumb) };
  const kb = (path: string): string => `${Math.round(statSync(join(PUBLIC, path)).size / 1024)} KB`;
  console.log(`${name}: ${mp4.frames} frames, ${mp4.codec}; mp4 ${v.mp4} (${kb(files.mp4)}), webm ${v.webm} (${kb(files.webm)}), still ${v.still} (${kb(files.still)}), thumb ${v.thumb} (${kb(files.thumb)})`);

  const call = new RegExp(`plateFiles\\("${name}", \\{[^}]*\\}, \\{[^}]*\\}\\)`);
  if (!call.test(source)) fail(`no plateFiles("${name}", …) line in src/lib/share-plates.ts`);
  source = source.replace(call, `plateFiles("${name}", { frames: ${mp4.frames}, codec: "${mp4.codec}" }, { mp4: "${v.mp4}", webm: "${v.webm}", still: "${v.still}", thumb: "${v.thumb}" })`);
}

writeFileSync(PLATES_TS, source);
console.log("\nNext: pnpm run check:plates && pnpm run check:render");
