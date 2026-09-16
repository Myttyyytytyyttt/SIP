// THE SCREENSHOT TOOL MUST START FROM A WORKTREE, WHERE THE PROOF IS RUN.
//
// tools/landing-shot/live-states.mjs photographs this package's live dashboard,
// and it is the only check that the connected screens render at all. Every
// branch of this work happens in a git worktree, which never has the tool's
// node_modules: Playwright is installed once, in the main checkout.
//
// The recipe that folder carried was `NODE_PATH=<main>/…/node_modules node
// live-states.mjs`, and it cannot work — these tools are ESM, and ESM
// resolution ignores NODE_PATH. The tool died at its first import, before any
// argument was read, so the screenshots could not be taken from the worktree at
// all. SIP_PLAYWRIGHT_DIR replaces it and is resolved explicitly.
//
// This test lives here because the web package's vitest is what runs in the
// gate, and a tool whose only job is to photograph this package should fail in
// the same run as the package. It touches no network and launches no browser:
// the resolution is exercised against a Playwright-shaped folder it builds
// itself, so it proves the mechanism without the 200 MB install.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { loadPlaywright, playwrightSearchPaths } from "../../../tools/landing-shot/playwright-module.mjs";

const TOOL = fileURLToPath(new URL("../../../tools/landing-shot/", import.meta.url));
const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A folder holding a node_modules/playwright that exports `body`, as CommonJS — the shape the real one has. */
function fakeInstall(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "saverfi-playwright-"));
  temporary.push(dir);
  const pkg = join(dir, "node_modules", "playwright");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0-test", main: "index.cjs" }));
  writeFileSync(join(pkg, "index.cjs"), body);
  return dir;
}

/** A folder with no node_modules at all. */
function emptyFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "saverfi-noplaywright-"));
  temporary.push(dir);
  return dir;
}

describe("which folder Playwright is resolved from", () => {
  it("uses Node's own resolution when the variable is unset or empty", () => {
    expect(playwrightSearchPaths({})).toBeNull();
    expect(playwrightSearchPaths({ SIP_PLAYWRIGHT_DIR: "" })).toBeNull();
  });

  it("uses exactly the folder the variable names", () => {
    expect(playwrightSearchPaths({ SIP_PLAYWRIGHT_DIR: "/main/tools/landing-shot" })).toEqual(["/main/tools/landing-shot"]);
  });
});

describe("loading it", () => {
  it("loads the install SIP_PLAYWRIGHT_DIR names, from outside this tree", () => {
    const dir = fakeInstall('module.exports = { chromium: { launch: async () => ({ marker: "from the named folder" }) } };');
    const playwright = loadPlaywright({ SIP_PLAYWRIGHT_DIR: dir });
    expect(typeof playwright.chromium.launch).toBe("function");
  });

  it("reads CommonJS named exports, which `await import()` in NODE does not", () => {
    // The trap this module exists to avoid: importing Playwright's resolved CJS
    // entry yields a namespace whose only key is `default`, so `chromium` comes
    // back undefined and the failure surfaces much later, as a launch on
    // undefined.
    //
    // Asked of node in a SUBPROCESS on purpose. Vitest transforms this file's
    // own imports and adds a CommonJS interop that Node has no equivalent of, so
    // an `await import()` written here would report named exports that the tool,
    // run by plain node, never gets — the assertion would pass for the wrong
    // reason and stop guarding anything.
    const dir = fakeInstall("module.exports = { chromium: { launch: async () => ({}) } };");
    const entry = pathToFileURL(join(dir, "node_modules", "playwright", "index.cjs")).href;
    const script = `const m = await import(${JSON.stringify(entry)}); console.log(JSON.stringify(Object.keys(m)));`;
    const keys = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(JSON.parse(keys)).toEqual(["default"]);

    // …while require, which is what loadPlaywright uses, hands back chromium.
    expect(loadPlaywright({ SIP_PLAYWRIGHT_DIR: dir }).chromium).toBeDefined();
  });

  it("names the variable, and the fix, when the folder has no playwright", () => {
    const dir = emptyFolder();
    expect(() => loadPlaywright({ SIP_PLAYWRIGHT_DIR: dir })).toThrow(/SIP_PLAYWRIGHT_DIR names .*no node_modules\/playwright/s);
    expect(() => loadPlaywright({ SIP_PLAYWRIGHT_DIR: dir })).toThrow(/npm i/);
  });

  it("refuses a folder whose 'playwright' is not Playwright, rather than failing at launch", () => {
    const dir = fakeInstall("module.exports = { somethingElse: true };");
    expect(() => loadPlaywright({ SIP_PLAYWRIGHT_DIR: dir })).toThrow(/no chromium\.launch/);
  });
});

describe("the tool itself", () => {
  const source = readFileSync(join(TOOL, "live-states.mjs"), "utf8");

  it("no longer tells anyone to set NODE_PATH, which ESM ignores", () => {
    // The assignment, not the word: the prose explains why NODE_PATH is gone.
    expect(source).not.toMatch(/NODE_PATH=/);
  });

  it("documents the recipe that works, and resolves through this module", () => {
    expect(source).toMatch(/SIP_PLAYWRIGHT_DIR=/);
    expect(source).toContain('from "./playwright-module.mjs"');
    // …and never goes back to a bare import, which is what broke in a worktree.
    expect(source).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["']playwright["']/);
  });
});
