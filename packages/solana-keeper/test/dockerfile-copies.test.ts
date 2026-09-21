// EVERY MODULE THE KEEPER IMPORTS MUST BE IN THE IMAGE.
//
// The Dockerfile copies source files BY NAME, one at a time, never a whole
// directory — deliberately, so nothing from target/, .localnet or a key file
// can ride along. The cost of that choice is that a new cross-package import
// typechecks, passes every test and runs under preflight on this machine, and
// then is simply absent from the container.
//
// IT HAS ALREADY HAPPENED. On 2026-09-21 the suite imported four Jupiter
// modules from @sip/solana-program that no COPY line named. The image runs
// `pnpm --dir packages/solana-keeper test` during the build, so collection
// failed and the build fell over — and nobody noticed, because production was
// still serving an older image built before those files existed. The first
// deploy would have found it.
//
// A COPY LINE'S LAST TOKEN IS ITS DESTINATION, NOT A SOURCE. Reading it as a
// source makes `packages/solana-program/scripts/` look like a whole directory
// that was copied, and then this check passes green while the image fails —
// which is exactly what a first cut of it did.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const KEEPER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(KEEPER, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

/** Sources of a COPY line: every token but the last, which is where they land. */
export function copiedPaths(dockerfile: string): readonly string[] {
  const joined = dockerfile.replace(/\\\r?\n\s*/g, " ");
  const out: string[] = [];
  for (const line of joined.split("\n")) {
    const match = /^\s*COPY\s+(.*)$/.exec(line);
    if (match === null) continue;
    const tokens = match[1]!.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("--"));
    for (const source of tokens.slice(0, -1)) out.push(source.replace(/\/$/, ""));
  }
  return out;
}

/** Every .ts under a directory, recursively. */
function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mts)$/.test(name)) out.push(full);
  }
  return out;
}

describe("the keeper's Dockerfile carries every module the keeper imports", () => {
  it("reads a COPY line's last token as its destination, never as a source", () => {
    const paths = copiedPaths("COPY a.ts b.ts dest/\nCOPY solo.ts other/\n");
    expect(paths).toEqual(["a.ts", "b.ts", "solo.ts"]);
    expect(paths, "a destination read as a source makes a whole directory look copied").not.toContain("dest");
  });

  it("resolves every @sip/solana-program import through the exports map and finds a COPY line naming it", () => {
    const exportsMap = JSON.parse(read("packages/solana-program/package.json")).exports as Record<string, unknown>;
    const copied = copiedPaths(read("packages/solana-keeper/Dockerfile"));

    const wanted = new Set<string>();
    for (const dir of ["src", "bin", "test"]) {
      for (const file of sourceFiles(resolve(KEEPER, dir))) {
        for (const [, sub] of readFileSync(file, "utf8").matchAll(/@sip\/solana-program\/([A-Za-z0-9._-]+)/g)) wanted.add(sub!);
      }
    }
    expect(wanted.size, "the keeper imports at least one @sip/solana-program module").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const sub of [...wanted].sort()) {
      const entry = exportsMap[`./${sub}`];
      const target = typeof entry === "string" ? entry : (entry as { default?: string; types?: string } | undefined)?.default;
      expect(target, `@sip/solana-program/${sub} has an entry in the exports map`).toBeDefined();
      const path = `packages/solana-program/${target!.replace(/^\.\//, "")}`;
      if (!copied.some((c) => path === c || path.startsWith(`${c}/`))) missing.push(`${sub} -> ${path}`);
    }
    expect(missing, "an import the image does not carry fails the build, not the tests, and only at deploy").toEqual([]);
  });
});
