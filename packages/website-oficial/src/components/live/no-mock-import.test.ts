// THE LIVE PANELS MUST NOT BE ONE IMPORT AWAY FROM THE SAMPLE.
//
// '@/mocks' re-exports the seeded dataset (`mock`) as well as the types. A live
// component that reaches for the barrel — even for a type — can have a stray
// `mock.stats.totalSavedUsd` added to it later and typecheck cleanly, and the
// result is a stranger's invented savings under a label promising someone their
// own pension. '@/mocks/types' is the leaf: types plus the pure tickerLogo path
// helper, and no data at all.
//
// This is a source test rather than a lint rule because it is a product rule,
// and it should fail in the same run as everything else.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/**
 * THE SAMPLE'S OWN COMPONENTS, WHICH NOW DRAW A LIVE PENSION TOO. Since 09-23
 * the live page mounts these very files, fed through src/lib/live-mock.ts, so
 * the rule this test exists for applies to them exactly as it does to the
 * panels under live/: one import of the dataset in any of them and a
 * stranger's invented savings could reach someone's real pension page.
 */
const SHARED = [
  "pension-panel.tsx",
  "pension-chart.tsx",
  "pension-stats.tsx",
  "pension-holdings.tsx",
  "savings-rule-panel.tsx",
  "savings-strip.tsx",
  "strip-chip.tsx",
  "wallet-activity.tsx",
  "activity-row.tsx",
  "dashboard-wallets.tsx",
  // The new-user setup sits over a connected key's live page.
  "onboarding/OnboardingBody.tsx",
  "onboarding/OnboardingDialog.tsx",
  "onboarding/OnboardingHost.tsx",
];

/** The live surface: every panel, every pure module behind them, and the sample components they share. */
function liveFiles(): string[] {
  const components = walk(join(SRC, "components", "live"));
  const libs = readdirSync(join(SRC, "lib"))
    .filter((name) => name.startsWith("live-") && (name.endsWith(".ts") || name.endsWith(".tsx")))
    .map((name) => join(SRC, "lib", name));
  const shared = SHARED.map((name) => join(SRC, "components", name));
  return [...components, ...libs, ...shared];
}

/**
 * `from "@/mocks"` — the barrel — or `from "@/mocks/data"`, the dataset itself,
 * in any import or re-export. '@/mocks/types' is allowed.
 */
const BARREL = /from\s*["']@\/mocks(?:\/data)?["']/;

/**
 * The file's CODE, with its prose removed.
 *
 * Several of these files explain in a comment that they import nothing from
 * '@/mocks' — and a naive scan reads that sentence as the very import it is
 * promising not to make. Block comments go, and so does any line that is one.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

describe("the live dashboard cannot reach the sample", () => {
  it("has files to check, so a rename cannot make this pass by finding nothing", () => {
    const files = liveFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((path) => path.endsWith("LiveBody.tsx"))).toBe(true);
    expect(files.some((path) => path.endsWith("live-model.ts"))).toBe(true);
    // The adapter that feeds the shared components, and the components themselves.
    expect(files.some((path) => path.endsWith("live-mock.ts"))).toBe(true);
    for (const name of SHARED) expect(files.some((path) => path.endsWith(`components/${name}`)), name).toBe(true);
  });

  it("imports the seeded dataset's barrel NOWHERE", () => {
    const offenders = liveFiles().filter((path) => BARREL.test(code(readFileSync(path, "utf8"))));
    expect(offenders.map((path) => path.slice(SRC.length))).toEqual([]);
  });

  it("allows the types leaf, which is what the one legitimate import uses", () => {
    const mark = readFileSync(join(SRC, "components", "live", "AssetMark.tsx"), "utf8");
    expect(mark).toContain('from "@/mocks/types"');
    expect(BARREL.test(code(mark))).toBe(false);
  });

  it("would still CATCH a real barrel import: the scan is not toothless", () => {
    // Assembled from pieces so THIS file never contains the literal it scans
    // for — the scan above reads every file here, including this one.
    const barrel = ["@", "/", "mocks"].join("");
    expect(BARREL.test(code(`import { mock } from "${barrel}";`))).toBe(true);
    expect(BARREL.test(code(`export { mock } from '${barrel}';`))).toBe(true);
    // …the dataset module reached directly is caught the same way…
    expect(BARREL.test(code(`import { mock } from "${barrel}/data";`))).toBe(true);
    // …the types leaf is not the barrel, and stays allowed.
    expect(BARREL.test(code(`import { tickerLogo } from "${barrel}/types";`))).toBe(false);
    // …and a sentence that merely mentions it is not an import.
    expect(BARREL.test(code(` * and nothing from '${barrel}': there is no sample data here`))).toBe(false);
  });
});
