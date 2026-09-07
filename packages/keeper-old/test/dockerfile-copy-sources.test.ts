// Every path a Dockerfile copies has to exist in the repository.
//
// THIS TEST EXISTS BECAUSE A DEPLOY DIED FOR THREE DAYS OVER A RENAME.
// packages/web became packages/website-oficial in 9dce569, and two Dockerfiles
// went on copying packages/web/package.json. The failure mode is what makes it
// worth a test rather than a code review:
//
//   A COPY WITH A MISSING SOURCE DOES NOT FAIL ITS OWN STEP. BuildKit resolves
//   sources while computing cache keys, before a single RUN executes, so the
//   build dies with "failed to compute cache key: ... not found" and every
//   stage in flight is cancelled and printed in red. The log accuses whatever
//   was running — in our case an apt-get in a completely unrelated stage, which
//   was then "hardened" against a failure it was never having.
//
// So the signal points away from the cause, and the only cheap way to catch it
// is here: on disk, in CI, before anything is pushed.
//
// WHY THE KEEPER'S SUITE CARRIES A TEST ABOUT OTHER PACKAGES' IMAGES. Because
// all three images are built from the REPOSITORY ROOT as their context — a
// relative path in any of them is a path in this repo — and because this is the
// package whose deploy the rot actually broke. A test that only guarded the
// keeper's own Dockerfile would have left the website image, which has the same
// dead paths, to be discovered the same way.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The images built from this repository, and the directory each one's relative
 * paths resolve against.
 *
 * All three are ROOT-CONTEXT builds. The keeper's and the website's say so in
 * their own headers ("building with packages/web as the context cannot work:
 * the install needs pnpm-lock.yaml"), and solana-lab's is settled by its
 * railway.json plus its own `COPY packages/solana-lab-old/program/...` lines, which
 * only resolve from the root.
 */
const IMAGES = [
  { dockerfile: "packages/keeper-old/Dockerfile", context: "." },
  { dockerfile: "packages/website-oficial/Dockerfile", context: "." },
  { dockerfile: "packages/solana-lab-old/program/Dockerfile", context: "." },
] as const;

interface CopySource {
  readonly line: number;
  readonly path: string;
}

/**
 * The COPY sources a Dockerfile resolves against the build context.
 *
 * `COPY --from=<stage>` is EXCLUDED, and that exclusion is the whole subtlety:
 * those paths live inside a previous stage's filesystem, not in the repo, so
 * asserting they exist on disk would fail on every correct Dockerfile here.
 *
 * Line continuations are joined first. None of the three images currently
 * writes a multi-line COPY, which is exactly why the parser should handle it —
 * a test that silently stops seeing a directive the day someone wraps a long
 * line is worse than no test, because it keeps reporting green.
 */
export function copySourcesOf(dockerfile: string): CopySource[] {
  const raw = dockerfile.split("\n");
  const found: CopySource[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    let text = raw[index] ?? "";
    const startedAt = index;
    while (text.trimEnd().endsWith("\\") && index + 1 < raw.length) {
      text = `${text.trimEnd().slice(0, -1)} ${raw[index + 1] ?? ""}`;
      index += 1;
    }

    const trimmed = text.trim();
    if (!/^COPY\s/i.test(trimmed)) continue;

    // Comments inside a continued directive are legal and carry no paths.
    const withoutComments = trimmed
      .split(/\s+/)
      .filter((token) => !token.startsWith("#"));

    const tokens = withoutComments.slice(1);
    // --from names a build stage, not the context. --chown / --link / --chmod
    // are flags whose values are not paths either.
    if (tokens.some((token) => token.toLowerCase().startsWith("--from="))) continue;
    const operands = tokens.filter((token) => !token.startsWith("--"));

    // The last operand is the destination inside the image.
    for (const source of operands.slice(0, -1)) {
      found.push({ line: startedAt + 1, path: source.replace(/^["']|["']$/g, "") });
    }
  }

  return found;
}

/** Whether a context-relative source resolves, allowing for shell globs. */
function resolves(context: string, source: string): boolean {
  const full = join(REPO_ROOT, context, source);
  if (!source.includes("*") && !source.includes("?")) return existsSync(full);

  // A glob only has to match SOMETHING. Docker fails a COPY whose pattern
  // matches nothing, and succeeds otherwise.
  const parent = dirname(full);
  if (!existsSync(parent)) return false;
  const pattern = new RegExp(
    `^${full
      .slice(parent.length + 1)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return readdirSync(parent).some((entry) => pattern.test(entry));
}

describe("what the images copy out of this repository", () => {
  for (const image of IMAGES) {
    it(`${image.dockerfile} copies only paths that exist`, () => {
      const path = join(REPO_ROOT, image.dockerfile);
      // A renamed or deleted Dockerfile must fail loudly here rather than pass
      // by having nothing left to check.
      expect(existsSync(path), `${image.dockerfile} is not in the repository`).toBe(true);

      const sources = copySourcesOf(readFileSync(path, "utf8"));
      // Same reasoning one level down: a parser that matched nothing would make
      // every image trivially "correct".
      expect(sources.length, `no COPY directives parsed out of ${image.dockerfile}`).toBeGreaterThan(0);

      const missing = sources.filter((source) => !resolves(image.context, source.path));
      expect(
        missing.map((source) => `${image.dockerfile}:${source.line} copies ${source.path}`),
        "a COPY source that does not exist fails the build while cache keys are computed, " +
          "before any step runs, and the error is reported against an unrelated step",
      ).toEqual([]);
    });
  }
});

describe("the parser itself", () => {
  it("ignores paths that live in another build stage", () => {
    expect(copySourcesOf("COPY --from=builder /repo/dist ./dist")).toEqual([]);
  });

  it("keeps flagged copies whose source is still the context", () => {
    expect(copySourcesOf("COPY --chown=keeper:keeper packages/keeper-old ./keeper")).toEqual([
      { line: 1, path: "packages/keeper-old" },
    ]);
  });

  it("reads a COPY that was wrapped across lines", () => {
    expect(copySourcesOf("COPY a.json \\\n  b.json \\\n  ./dest/")).toEqual([
      { line: 1, path: "a.json" },
      { line: 1, path: "b.json" },
    ]);
  });

  it("takes every operand but the destination", () => {
    expect(copySourcesOf("COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./")).toEqual([
      { line: 1, path: "pnpm-lock.yaml" },
      { line: 1, path: "pnpm-workspace.yaml" },
      { line: 1, path: "package.json" },
    ]);
  });
});
