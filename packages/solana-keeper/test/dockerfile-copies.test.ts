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
 * The directories the image's own gates load, read from tsconfig.json rather
 * than typed out here.
 *
 * THE HARDCODED THREE WERE A HOLE, AND IT WAS OPEN. This function used to be
 * the literal ["src", "bin", "test"], with a comment arguing that test-local/
 * is excluded because vitest.config.ts collects only test/** and src/**. True
 * of vitest — and the image runs `tsc -p tsconfig.json --noEmit` as well, whose
 * include list ends with "test-local/**\/*.ts". Two files there import
 * @sip/solana-program/link-consent, the one exported script no COPY line named,
 * so the TYPECHECK gate died in the container while this guard stayed green.
 * Reading the include list is what stops the next directory added to it from
 * being invisible here too.
 */
function includedDirs(): readonly string[] {
  const include = JSON.parse(read("packages/solana-keeper/tsconfig.json")).include as readonly string[] | undefined;
  expect(include, "packages/solana-keeper/tsconfig.json states an include list").toBeDefined();
  const dirs = new Set<string>();
  for (const pattern of include!) {
    const head = pattern.split("/")[0]!;
    if (head.length === 0 || head.includes("*")) continue;
    dirs.add(head);
  }
  expect([...dirs], "the image typechecks test-local/, so this guard reads it too").toContain("test-local");
  return [...dirs].sort();
}

/** A module specifier as an IMPORT, not as any quoted string that looks like a path. */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`](\.\.?\/[^"'`]+)["'`]/g;

/** The file a relative specifier names, with the extensions this repository actually uses. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.mts`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this spelling
    }
  }
  return null;
}

/** Where a bare @sip specifier lands, through the other package's exports map. */
function throughExportsMap(pkg: string, sub: string | undefined): string {
  const map = JSON.parse(read(`packages/${pkg}/package.json`)).exports as Record<string, unknown> | undefined;
  expect(map, `packages/${pkg} declares an exports map`).toBeDefined();
  const entry = map![sub === undefined ? "." : `.${sub}`];
  const target = typeof entry === "string" ? entry : (entry as { default?: string } | undefined)?.default;
  expect(target, `@sip/${pkg}${sub ?? ""} has an entry in packages/${pkg}'s exports map`).toBeDefined();
  return `packages/${pkg}/${target!.replace(/^\.\//, "")}`;
}

/**
 * Every path this package reaches OUTSIDE itself, by either route, TRANSITIVELY.
 *
 * TWO ROUTES, AND THE SECOND IS THE ONE THAT BIT. A bare specifier resolves
 * through the other package's exports map; a RELATIVE path (../../solana-core/…)
 * bypasses the map entirely and is invisible to a check that only looks for
 * "@sip/". test/pyth.test.ts reaches two solana-core files that way, assembling
 * part of the specifier at runtime so tsc leaves the sibling alone — so the
 * literal is a template and has to be expanded before it means anything.
 *
 * AND TRANSITIVELY, WHICH IS THE SECOND HOLE THIS GUARD HAD. It certified that
 * the keeper's OWN files each had a COPY line and stopped there, so a copied
 * file's own imports were invisible: packages/solana-core/src/client/pyth-price.ts
 * was named, and the five siblings it imports on its lines 33-37 were not. The
 * image failed at `RUN pnpm --dir packages/solana-keeper test` with "Cannot find
 * module './addresses'" while this test reported three passes. A file is in the
 * image only if everything it imports is, so the walk continues from each file
 * it has just certified, out to the fixpoint. `.json` and package dependencies
 * are ends of the walk: only .ts and .mts carry more relative imports.
 */
function reachedOutside(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  const CONSTANT = /const\s+([A-Z_][A-Z_0-9]*)\s*=\s*"([^"]+)"/g;
  const RELATIVE = /["'`](\.\.\/\.\.\/[^"'`]+)["'`]/g;
  // QUOTED ONLY. A bare mention in prose ("the keeper does not depend on
  // @sip/solana-core") is not an import, and counting it sends this check
  // hunting for an exports entry that has no reason to exist.
  const BARE = /["'`]@sip\/([a-z0-9-]+)(\/[A-Za-z0-9._\/-]+)?["'`]/g;

  const note = (abs: string, from: string): void => {
    const path = abs.slice(ROOT.length + 1);
    out.set(path, [...(out.get(path) ?? []), from]);
  };

  // THE KEEPER'S OWN FILES, and the template expansion that makes pyth.test.ts's
  // runtime-assembled specifier readable at all.
  const queue: string[] = [];
  for (const dir of includedDirs()) {
    for (const file of sourceFiles(resolve(KEEPER, dir))) {
      const text = readFileSync(file, "utf8");
      const from = file.slice(KEEPER.length + 1);
      const constants = new Map([...text.matchAll(CONSTANT)].map(([, k, v]) => [k!, v!]));
      for (const [, raw] of text.matchAll(RELATIVE)) {
        let spec = raw!;
        for (const [k, v] of constants) spec = spec.split("${" + k + "}").join(v);
        if (spec.includes("${")) continue;
        // A MODULE, NOT ANY PATH THAT LOOKS LIKE ONE. This scan is deliberately
        // loose — it reads quoted strings rather than import statements, because
        // test/pyth.test.ts assembles its specifier at runtime and an import
        // scanner would never see it. The cost is that a DATA path matches too:
        // test-local/local-validator.ts names
        // ../../solana-program/target/deploy/sip_vault.so to hand to
        // solana-test-validator, and target/deploy is the one directory the
        // Dockerfile's header forbids copying because it holds the program's
        // upgrade keypair. Neither tsc nor vitest resolves that string, and the
        // image loads neither the file nor the harness, so what counts here is
        // what those two resolve: a TypeScript module.
        if (!/\.(ts|mts)$/.test(spec)) continue;
        const abs = resolve(dirname(file), spec);
        if (abs.startsWith(`${KEEPER}/`)) continue;
        note(abs, from);
        queue.push(abs);
      }
      for (const [, pkg, sub] of text.matchAll(BARE)) {
        if (pkg === "solana-keeper") continue;
        const path = throughExportsMap(pkg!, sub);
        out.set(path, [...(out.get(path) ?? []), from]);
        queue.push(resolve(ROOT, path));
      }
    }
  }

  // AND EVERYTHING THOSE FILES REACH, to the fixpoint.
  const walked = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (walked.has(file)) continue;
    walked.add(file);
    if (!/\.(ts|mts)$/.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // A path that does not exist is not this guard's finding: the COPY check
      // below reports it as uncopied, which is the actionable form of it.
      continue;
    }
    const from = file.slice(ROOT.length + 1);
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      const target = resolveRelative(file, spec!);
      if (target === null || target.startsWith(`${KEEPER}/`)) continue;
      note(target, from);
      queue.push(target);
    }
    for (const [, pkg, sub] of text.matchAll(BARE)) {
      if (pkg === "solana-keeper") continue;
      const path = throughExportsMap(pkg!, sub);
      out.set(path, [...(out.get(path) ?? []), from]);
      queue.push(resolve(ROOT, path));
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

  it("follows what a reached file itself imports, not only the first hop out of this package", () => {
    const reached = [...reachedOutside().keys()];
    // pyth-price.ts:33-37. None of these five is named by any keeper file; they
    // are in the image only because the file that imports them is.
    for (const sibling of ["addresses", "base58", "clmm-price", "idl", "rules"]) {
      expect(reached, `pyth-price.ts imports ./${sibling}, so the image needs it too`).toContain(
        `packages/solana-core/src/client/${sibling}.ts`,
      );
    }
    // And one hop further out of the fixture, by a different relative shape.
    expect(reached, "pyth-accounts.ts imports ../../src/client/base64").toContain("packages/solana-core/src/client/base64.ts");
  });

  it("reads the directories the image typechecks, so test-local's reaches count too", () => {
    expect(includedDirs(), "tsconfig.json's include is what `tsc -p tsconfig.json` loads in the image").toContain("test-local");
    const reached = reachedOutside();
    expect([...reached.keys()], "test-local/*.local.test.ts imports @sip/solana-program/link-consent").toContain(
      "packages/solana-program/scripts/link-consent.ts",
    );
  });
});
