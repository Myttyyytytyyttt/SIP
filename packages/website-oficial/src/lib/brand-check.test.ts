// THE REBRAND'S OWN VERIFICATION COMMAND, held to what git actually does.
//
// `git grep -E` is POSIX ERE, which has no \b. A search for the code name
// written that way matches NOTHING — not "no user-visible uses left", but
// nothing whatsoever — so it answers a rebrand check with a silent all-clear on
// a repository full of the word. `-w` is the form that works.
//
// The claim is about git's behaviour, so this runs the real thing against the
// real checkout rather than asserting it from memory.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const README = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");

const BOUNDARY = String.raw`\b`;
/** \bSIP\b, assembled from pieces so that this file is not itself a hit for the search below. */
const ERE_PATTERN = `${BOUNDARY}SIP${BOUNDARY}`;
/** The broken command as somebody would write it down. */
const ERE_WRITTEN = `-E '${ERE_PATTERN}'`;

/**
 * `git grep -l -I <flags> -- <pattern>`: the files matched, or null when git
 * cannot answer here (no git, no checkout).
 *
 * The `--` matters: a pattern beginning with a dash is read as an option
 * without it, which is how this test first failed.
 */
function grepFiles(flags: readonly string[], pattern: string): string[] | null {
  try {
    return execFileSync("git", ["grep", "-l", "-I", ...flags, "--", pattern], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "");
  } catch (error) {
    // Exit 1 is "no file matched", which is an answer. Anything else means the
    // question cannot be put here, and the test skips rather than passes.
    return (error as { status?: number }).status === 1 ? [] : null;
  }
}

const gitAnswers = grepFiles(["-w"], "SIP") !== null;

describe("the command for finding the code name", () => {
  it("is the -w form in the README, with the -E one warned off", () => {
    expect(README).toContain("git grep -n -I -w SIP");
    expect(README).toMatch(/Never `git grep -n -I -E/);
  });

  it.skipIf(!gitAnswers)("finds the word, where the -E form finds nothing at all", () => {
    const byWord = grepFiles(["-w"], "SIP")!;
    const byEre = grepFiles(["-E"], ERE_PATTERN)!;

    // The code name is still everywhere it belongs: package names, the program,
    // the SIP_* settings.
    expect(byWord.length).toBeGreaterThan(0);
    expect(byWord).toContain("README.md");

    // …and the command a person reaches for reports a clean repository.
    expect(byEre).toEqual([]);
  });

  it.skipIf(!gitAnswers)("is the only form written down anywhere in the repository", () => {
    // If the broken command is ever pasted into a runbook or a comment, this
    // fails and names the file. The README may hold it: that is where it is
    // labelled as the one never to use.
    expect(grepFiles(["-F"], ERE_WRITTEN)).toEqual(["README.md"]);
  });
});
