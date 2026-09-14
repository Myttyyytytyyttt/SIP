// Fails if the committed dist/ no longer matches the Solidity it claims to describe.
//
// WHY THIS EXISTS.
//
// dist/ is the one build product this repo tracks in git, and the .gitignore
// carries a deliberate negation to allow it. The reason is deployment: Railway
// builds from git and the web image has no Foundry, so a tracked dist/ is the
// only way the container can obtain the ABIs.
//
// The cost of that convenience is drift. Edit a contract, forget to re-export,
// and packages/web keeps consuming the previous ABI — silently. Nothing errors:
// an ABI missing a newly added field simply decodes less, and a selector that
// moved produces a revert the dashboard reports as an ordinary failed read. This
// script is what makes the tracked directory safe.
//
//   node scripts/check-dist-fresh.mjs
//
// Rebuilds through the normal export path and then asks git whether anything
// changed. Skips (exit 0) when Foundry is unavailable or when dist/ is not yet
// tracked, so it never blocks a container build or a fresh clone.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = "packages/contracts-artifacts/dist";

const git = (...args) => execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" }).trim();

// A fresh clone before the first export, or a deliberate untracked-dist policy.
// Either way there is no committed baseline to compare against.
let tracked;
try {
  tracked = git("ls-files", "--", `${packageRoot}/dist`).length > 0;
} catch (error) {
  console.log(`[artifacts] dist freshness check skipped: git unavailable (${error.message.split("\n")[0]}).`);
  process.exit(0);
}
if (!tracked) {
  console.log(`[artifacts] dist freshness check skipped: ${DIST} is not tracked, so there is no baseline.`);
  process.exit(0);
}

if (spawnSync("forge", ["--version"], { shell: true, stdio: "ignore" }).status !== 0) {
  console.log("[artifacts] dist freshness check skipped: Foundry is not installed, so dist/ cannot be re-derived.");
  process.exit(0);
}

// Re-export exactly the way a developer would. Determinism is already asserted by
// artifacts.test.mjs ("reproduces byte-for-byte output from the same Forge
// artifacts"), so any diff below is a real difference in the contracts.
const build = spawnSync("node", ["scripts/export-artifacts.mjs"], {
  cwd: packageRoot,
  encoding: "utf8",
  shell: true,
});
if (build.status !== 0) {
  console.error("[artifacts] dist freshness check FAILED: the export itself did not succeed.");
  console.error((build.stderr || build.stdout || "").slice(-2000));
  process.exit(1);
}

// --stat rather than --quiet: when this fails, the useful information is WHICH
// contract moved, and a bare exit code sends the reader back to run it again.
const diff = git("diff", "--stat", "--", "dist");
if (diff.length > 0) {
  console.error(`[artifacts] dist freshness check FAILED: ${DIST} is stale.`);
  console.error("");
  console.error("  Re-exporting from the current Solidity produced different output, so the");
  console.error("  committed ABIs describe contracts that no longer exist as written. Anything");
  console.error("  consuming this package — packages/web in particular — is decoding against");
  console.error("  the previous interface.");
  console.error("");
  console.error(diff.split("\n").map((line) => `  ${line}`).join("\n"));
  console.error("");
  console.error(`  The working tree now holds the correct output. Commit it:`);
  console.error(`    git add ${DIST} && git commit -m "Re-export contract artifacts"`);
  process.exit(1);
}

console.log(`[artifacts] dist freshness check passed: ${DIST} matches the current Solidity.`);
