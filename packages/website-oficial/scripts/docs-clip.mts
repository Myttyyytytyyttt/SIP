/**
 * A DOCS CLIP, READY TO SERVE: its two loops in public/docs/clips/, its poster
 * made from the loop's first frame, and every file's version written into
 * src/lib/docs/clips.ts.
 *
 * Run from packages/website-oficial (needs ffmpeg and cwebp: `brew install ffmpeg webp`):
 *
 *   pnpm run docs:clip <slug>… --from <checkout>/launch-video/out/docs
 *       copies <slug>.webm and <slug>.mp4 in from the films' output first
 *       (launch-video/ is read, never written: it belongs to the films).
 *   pnpm run docs:clip <slug>…
 *       the loops already in public/: makes the poster again and re-writes the versions.
 *   pnpm run docs:clip dashboard
 *       the dashboard page's poster, from the landing's own app loop, which that
 *       page reuses. Run it again whenever public/landing/app-loop.* is re-rendered.
 *
 * TO ADD A CLIP: run it with --from; a slug not in CLIPS yet gets its line
 * printed, to paste into CLIPS; then `CI=1 vitest run src/app/docs`.
 *
 * A VERSION IN EVERY URL (?v=, the first 8 hex of the file's sha256), because
 * /docs/clips/* is served with a year-long immutable cache (next.config.mjs): a
 * clip re-rendered under the same name gets a new address, so no browser can
 * keep showing the old one. src/app/docs/docs.test.ts recomputes every version
 * and fails on a stale one: a file changed without this script fails CI.
 *
 * THE POSTER IS THE MP4'S FIRST FRAME, AS WebP: the frame the loop opens on, so
 * nothing jumps when the loop takes over from it, at about 40 % of the films'
 * JPEG for a picture closer to the frame (measured 10-22: 253 KB for the ten
 * posters against 647 KB). It is the page's largest paint, so its size is how
 * soon the page looks ready.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOC_PAGES } from "../src/lib/docs/pages.ts";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC = join(PACKAGE, "public");
const CLIPS_TS = join(PACKAGE, "src/lib/docs/clips.ts");

/** WebP quality 88 with sharp RGB→YUV: closer to the frame than the films' JPEG, so no banding in the dark gradients. */
const CWEBP = ["-quiet", "-q", "88", "-m", "6", "-sharp_yuv", "-af"];

/** The one page whose loop is not its own: the dashboard page plays the landing's app loop. */
const BORROWED: Readonly<Record<string, { readonly webm: string; readonly mp4: string }>> = {
  dashboard: { webm: "/landing/app-loop.webm", mp4: "/landing/app-loop.mp4" },
};

function fail(message: string): never {
  console.error(`docs:clip: ${message}`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: ["ignore", "ignore", "inherit"] });
  if (result.error !== undefined) fail(`${command} did not run (${result.error.message}); brew install ffmpeg webp`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
}

const versionOf = (path: string): string => createHash("sha256").update(readFileSync(join(PUBLIC, path))).digest("hex").slice(0, 8);

const args = process.argv.slice(2);
const fromAt = args.indexOf("--from");
const from = fromAt === -1 ? null : (args[fromAt + 1] ?? "");
if (from !== null && !existsSync(from)) fail(`--from needs the films' output folder (launch-video/out/docs), got "${from}"`);
const slugs = fromAt === -1 ? args : args.filter((_, at) => at !== fromAt && at !== fromAt + 1);
if (slugs.length === 0) fail("name at least one docs page: pnpm run docs:clip <slug>… [--from <launch-video>/out/docs]");

let source = readFileSync(CLIPS_TS, "utf8");
const missing: string[] = [];

for (const slug of slugs) {
  if (!DOC_PAGES.some((page) => page.slug === slug)) fail(`${slug} is not a docs page (src/lib/docs/pages.ts)`);
  const borrowed = BORROWED[slug];
  const files = { webm: borrowed?.webm ?? `/docs/clips/${slug}.webm`, mp4: borrowed?.mp4 ?? `/docs/clips/${slug}.mp4`, poster: `/docs/clips/${slug}.webp` };

  if (from !== null && borrowed === undefined) {
    for (const kind of ["webm", "mp4"] as const) copyFileSync(join(from, `${slug}.${kind}`), join(PUBLIC, files[kind]));
  }
  for (const kind of ["webm", "mp4"] as const) if (!existsSync(join(PUBLIC, files[kind]))) fail(`${slug}: public${files[kind]} is missing (pass --from)`);

  const scratch = mkdtempSync(join(tmpdir(), "docs-clip-"));
  try {
    const frame = join(scratch, "frame.png");
    run("ffmpeg", ["-v", "error", "-y", "-i", join(PUBLIC, files.mp4), "-frames:v", "1", frame]);
    run("cwebp", [...CWEBP, frame, "-o", join(PUBLIC, files.poster)]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const v = { webm: versionOf(files.webm), mp4: versionOf(files.mp4), poster: versionOf(files.poster) };
  const kb = (path: string): string => `${Math.round(statSync(join(PUBLIC, path)).size / 1024)} KB`;
  console.log(`${slug}: webm ${v.webm} (${kb(files.webm)}), mp4 ${v.mp4} (${kb(files.mp4)}), poster ${v.poster} (${kb(files.poster)})`);

  // An own clip is one `clipFiles("<slug>", { … })` call; a borrowed one names its files whole, each with its ?v=.
  const call = new RegExp(`clipFiles\\("${slug}", \\{[^}]*\\}\\)`);
  const own = `clipFiles("${slug}", { webm: "${v.webm}", mp4: "${v.mp4}", poster: "${v.poster}" })`;
  if (borrowed === undefined && call.test(source)) {
    source = source.replace(call, own);
  } else if (borrowed !== undefined && source.includes(`"${files.webm}?v=`)) {
    for (const kind of ["webm", "mp4", "poster"] as const) {
      source = source.replace(new RegExp(`"${files[kind].replaceAll(".", "\\.")}\\?v=[0-9a-f]{8}"`), `"${files[kind]}?v=${v[kind]}"`);
    }
  } else {
    const entry = borrowed === undefined ? own : `{ ${(["webm", "mp4", "poster"] as const).map((kind) => `${kind}: "${files[kind]}?v=${v[kind]}"`).join(", ")} }`;
    missing.push(`  ${/^[a-z]+$/.test(slug) ? slug : `"${slug}"`}: ${entry},`);
  }
}

writeFileSync(CLIPS_TS, source);
if (missing.length > 0) console.log(`\nNot in CLIPS yet: add to src/lib/docs/clips.ts\n${missing.join("\n")}`);
