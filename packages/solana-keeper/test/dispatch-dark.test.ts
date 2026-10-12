// DARK, AS ONE PROPERTY OVER THE MERGED DISPATCHER (plan P3a; plan §2 rule 1):
// no entry point under bin/ reaches a dispatcher module through ANY chain of
// imports.
//
// WHY THIS AND NOT ONLY THE TRACKS' OWN GUARDS. Each P3a track guarded itself
// by name: the store by "no file under src/ or bin/ imports dispatch-store",
// the budget by "nothing under bin/ names rpc-budget, rpc-quota or
// credit-governor", the fleet by construction (nothing outside src/fleet-*.ts
// imported it). Since the merge the modules lean on one another — the store
// reads the fleet page's stats keys and the budget's quota types — and a
// one-hop name check no longer says what matters: whether a process production
// starts LOADS any of them. This walks the import graph from every file in bin/
// (bin/keeper.mts is what the Dockerfile runs, for both legacy roles) and
// fails on the first dispatcher module it can reach, naming the chain.
//
// rpc-budget.ts IS REACHABLE, AND THAT IS THE BUDGET TRACK'S DESIGN: poolFetch
// (src/rpc-pool.ts) imports it, and is dark because no legacy caller passes it a
// sixth argument (test/rpc-budget-parity.test.ts counts them). It is listed
// below as reachable on purpose, so that this file says so rather than hiding it.
//
// WHEN THE DISPATCHER'S OWN ENTRY POINTS LAND (Q2, Q3), they go in
// DISPATCHER_ENTRY_POINTS: they are the only files allowed to reach these.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const KEEPER = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every module of the dispatcher that a legacy process must never load. */
const DISPATCHER_MODULES = [
  "src/dispatch-store.ts",
  "src/fleet-receiver.ts",
  "src/fleet-pg.ts",
  "src/fleet-status.ts",
  "src/fleet-alerts.ts",
  "src/rpc-quota.ts",
  "src/credit-governor.ts",
  // Q2, the scheduler.
  "src/scheduler.ts",
  "src/scheduler-pg.ts",
  "src/scheduler-select.ts",
  "src/scheduler-chain.ts",
  "src/scheduler-config.ts",
  "src/scheduler-board.ts",
  "src/lamports-filter.ts",
] as const;

/** bin/ files that are the dispatcher's own: the only ones allowed to reach the modules above (Q3 adds the worker's). */
const DISPATCHER_ENTRY_POINTS: readonly string[] = ["bin/scheduler.mts"];

/** Relative specifiers, static (import/export … from, bare import) and dynamic. Type-only imports load nothing. */
function relativeImports(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /^\s*import\s+(?!type\b)[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/gms,
    /^\s*export\s+(?!type\b)[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/gms,
    /^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) out.push(match[1]!);
  return out;
}

function resolveSpecifier(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`]) {
    if (existsSync(candidate) && candidate.startsWith(KEEPER) && /\.(ts|mts)$/.test(candidate)) return candidate;
  }
  return null;
}

/** Every keeper file `entry` loads, each with the chain that first reached it. */
function reach(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of relativeImports(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(file, specifier);
      if (target === null || seen.has(target)) continue;
      seen.set(target, [...seen.get(file)!, target]);
      queue.push(target);
    }
  }
  return seen;
}

const rel = (file: string): string => relative(KEEPER, file);

describe("DARK: no entry point production can start reaches a dispatcher module", () => {
  it("follows static, re-exported, bare and dynamic imports, and not a type-only one or a comment", () => {
    const text = [
      'import { a } from "./one.js";',
      'export { b } from "../two.js";',
      'import "./three.js";',
      'const c = await import("./four.js");',
      'import type { D } from "./five.js";',
      'export type { E } from "./six.js";',
      "// see ./seven.js",
      'import pg from "pg";',
    ].join("\n");
    expect(relativeImports(text).sort()).toEqual(["../two.js", "./four.js", "./one.js", "./three.js"]);
  });

  const entries = readdirSync(resolve(KEEPER, "bin"))
    .filter((name) => /\.(ts|mts)$/.test(name))
    .map((name) => resolve(KEEPER, "bin", name))
    .filter((file) => !DISPATCHER_ENTRY_POINTS.includes(rel(file)));

  it("walks a real graph: bin/keeper.mts loads the legacy keeper, rpc-budget among it (dark by poolFetch's arguments)", () => {
    const keeper = reach(resolve(KEEPER, "bin/keeper.mts"));
    expect(keeper.size).toBeGreaterThan(20);
    expect(keeper.has(resolve(KEEPER, "src/rpc-pool.ts"))).toBe(true);
    expect(keeper.has(resolve(KEEPER, "src/rpc-budget.ts"))).toBe(true);
    for (const module of DISPATCHER_MODULES) expect(existsSync(resolve(KEEPER, module)), module).toBe(true);
  });

  it("the scheduler's entry point is the dispatcher's, reaches its modules, and is not what the image runs", () => {
    const scheduler = reach(resolve(KEEPER, "bin/scheduler.mts"));
    for (const module of ["src/scheduler.ts", "src/scheduler-pg.ts", "src/dispatch-store.ts", "src/fleet-receiver.ts", "src/lamports-filter.ts"]) {
      expect(scheduler.has(resolve(KEEPER, module)), module).toBe(true);
    }
    const dockerfile = readFileSync(resolve(KEEPER, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^CMD \["node_modules\/\.bin\/tsx", "bin\/keeper\.mts"\]$/m);
    expect(dockerfile).not.toMatch(/scheduler\.mts/);
  });

  it.each(entries.map((file) => [rel(file), file] as const))("%s reaches none of them", (_name, file) => {
    const reached = reach(file);
    const leaks = DISPATCHER_MODULES.flatMap((module) => {
      const chain = reached.get(resolve(KEEPER, module));
      return chain === undefined ? [] : [chain.map(rel).join(" → ")];
    });
    expect(leaks).toEqual([]);
  });
});
