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

/**
 * Every path this package reaches OUTSIDE itself, by either route.
 *
 * TWO ROUTES, AND THE SECOND IS THE ONE THAT BIT. A bare specifier resolves
 * through the other package's exports map; a RELATIVE path (../../solana-core/…)
 * bypasses the map entirely and is invisible to a check that only looks for
 * "@sip/". test/pyth.test.ts reaches two solana-core files that way, assembling
 * part of the specifier at runtime so tsc leaves the sibling alone — so the
 * literal is a template and has to be expanded before it means anything.
 *
 * test-local/ is excluded on purpose: vitest.config.ts includes only
 * test/** and src/**, so the image's own `pnpm test` never loads it.
 */
function reachedOutside(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  const CONSTANT = /const\s+([A-Z_][A-Z_0-9]*)\s*=\s*"([^"]+)"/g;
  const RELATIVE = /["'`](\.\.\/\.\.\/[^"'`]+)["'`]/g;
  // QUOTED ONLY. A bare mention in prose ("the keeper does not depend on
  // @sip/solana-core") is not an import, and counting it sends this check
  // hunting for an exports entry that has no reason to exist.
  const BARE = /["'`]@sip\/([a-z0-9-]+)(\/[A-Za-z0-9._\/-]+)?["'`]/g;
  for (const dir of ["src", "bin", "test"]) {
    for (const file of sourceFiles(resolve(KEEPER, dir))) {
      const text = readFileSync(file, "utf8");
      const from = file.slice(KEEPER.length + 1);
      const constants = new Map([...text.matchAll(CONSTANT)].map(([, k, v]) => [k!, v!]));
      for (const [, raw] of text.matchAll(RELATIVE)) {
        let spec = raw!;
        for (const [k, v] of constants) spec = spec.split("${" + k + "}").join(v);
        if (spec.includes("${")) continue;
        const abs = resolve(dirname(file), spec);
        if (abs.startsWith(`${KEEPER}/`)) continue;
        out.set(abs.slice(ROOT.length + 1), [...(out.get(abs.slice(ROOT.length + 1)) ?? []), from]);
      }
      for (const [, pkg, sub] of text.matchAll(BARE)) {
        if (pkg === "solana-keeper") continue;
        const map = JSON.parse(read(`packages/${pkg}/package.json`)).exports as Record<string, unknown> | undefined;
        expect(map, `packages/${pkg} declares an exports map`).toBeDefined();
        const entry = map![sub === undefined ? "." : `.${sub}`];
        const target = typeof entry === "string" ? entry : (entry as { default?: string } | undefined)?.default;
        expect(target, `@sip/${pkg}${sub ?? ""} has an entry in packages/${pkg}'s exports map`).toBeDefined();
        const path = `packages/${pkg}/${target!.replace(/^\.\//, "")}`;
        out.set(path, [...(out.get(path) ?? []), from]);
      }
    }
  }
  return out;
}

describe("the keeper's Dockerfile carries every module the keeper imports", () => {
  it("reads a COPY line's last token as its destination, never as a source", () => {
    const paths = copiedPaths("COPY a.ts b.ts dest/\nCOPY solo.ts other/\n");
    expect(paths).toEqual(["a.ts", "b.ts", "solo.ts"]);
    expect(paths, "a destination read as a source makes a whole directory look copied").not.toContain("dest");
  });

  it("names, in a COPY line, every file this package reaches outside itself — bare specifier or relative path", () => {
    const copied = copiedPaths(read("packages/solana-keeper/Dockerfile"));
    const reached = reachedOutside();
    expect(reached.size, "the keeper reaches at least one file outside its own package").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [path, from] of [...reached].sort()) {
      if (!copied.some((c) => path === c || path.startsWith(`${c}/`))) missing.push(`${path}  (from ${[...new Set(from)].sort().join(", ")})`);
    }
    expect(missing, "a file the image does not carry fails the BUILD, not the tests, and only at deploy").toEqual([]);
  });

  it("sees the relative reaches too, not only the bare specifiers", () => {
    const reached = [...reachedOutside().keys()];
    expect(reached, "test/pyth.test.ts reaches these by relative path with a runtime-assembled tail").toContain("packages/solana-core/test/fixtures/pyth-accounts.ts");
    expect(reached).toContain("packages/solana-core/src/client/pyth-price.ts");
  });
});
