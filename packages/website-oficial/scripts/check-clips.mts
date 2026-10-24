/**
 * THE DOCS' CLIPS, CHECKED BEFORE A BUILD SHIPS THEM.
 *
 * Run: pnpm run check:clips   (prebuild runs it, like check:csp, so a deploy enforces it)
 *
 * WHY BEFORE THE BUILD AND NOT ONLY IN THE TESTS. A /docs/clips/ URL is cached
 * for a year without asking again (next.config.mjs), so a file changed under the
 * same address would never reach a browser that already has the old one. That
 * is why each such URL carries its file's version (?v=, src/lib/docs/clips.ts).
 * A stale version is invisible on the page and in every log, and a deploy runs
 * the build, never vitest: so the build checks it. docs.test.ts asks the same
 * question through clipProblems() below.
 *
 * WHAT IS CHECKED, for every file of every clip in CLIPS:
 *   * it is in public/ (a page never points a <video> at a file that is not there);
 *   * under /docs/clips/, its URL ends in ?v=<the first 8 hex of its sha256>;
 *   * anywhere else (the dashboard page's loop, borrowed from /landing/), no ?v=:
 *     that file keeps its own folder's caching, and the landing's exact URL is
 *     what lets a reader who has seen the landing reuse it.
 *
 * TO FIX A FAILURE: `pnpm run docs:clip <slug>` rewrites the versions.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIPS } from "../src/lib/docs/clips.ts";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

/** The prefix whose files are cached for a year: the one place a ?v= is required. */
export const VERSIONED = "/docs/clips/";

/** The first 8 hex of a public/ file's sha256: the version its URL must carry. */
export function versionOf(path: string): string {
  return createHash("sha256").update(readFileSync(join(PUBLIC, path))).digest("hex").slice(0, 8);
}

/** Every way CLIPS disagrees with public/, one line each; [] when the clips can ship. */
export function clipProblems(): string[] {
  const problems: string[] = [];
  for (const [slug, files] of Object.entries(CLIPS)) {
    for (const url of [files!.webm, files!.mp4, files!.poster]) {
      const [path = "", query] = url.split("?");
      if (!existsSync(join(PUBLIC, path))) {
        problems.push(`${slug}: public${path} is missing`);
      } else if (path.startsWith(VERSIONED)) {
        const wanted = `${path}?v=${versionOf(path)}`;
        if (url !== wanted) problems.push(`${slug}: ${url} should be ${wanted} (the file changed since its version was written; run pnpm run docs:clip ${slug})`);
      } else if (query !== undefined) {
        problems.push(`${slug}: ${url} is outside ${VERSIONED} and should carry no query (it keeps its own folder's caching)`);
      }
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("[web] the docs' clips");
  const problems = clipProblems();
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  if (problems.length === 0) console.log(`  ok    ${Object.keys(CLIPS).length} clips: every file in public/, every ${VERSIONED} URL at its file's version`);
  console.log(problems.length === 0 ? "[web] clips check passed\n" : `[web] clips check: ${problems.length} FAILED\n`);
  if (problems.length > 0) process.exit(1);
}
