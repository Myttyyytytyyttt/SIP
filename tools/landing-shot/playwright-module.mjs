// Where Playwright comes from when this tool runs from a git WORKTREE.
//
// tools/landing-shot is deliberately not a workspace package, so Playwright
// never enters the web image — which also means `pnpm install` never puts it in
// a worktree. The one install that exists is the main checkout's own
// `cd tools/landing-shot && npm i`, and a worktree has to be pointed at it:
//
//   SIP_PLAYWRIGHT_DIR=<main checkout>/tools/landing-shot node live-states.mjs
//
// WHY NOT NODE_PATH. These tools are ESM, and ESM resolution ignores NODE_PATH
// altogether — it is honoured only by CommonJS require. The recipe that named it
// failed at the import, before a single argument was read, with "Cannot find
// package 'playwright'". SIP_PLAYWRIGHT_DIR is resolved explicitly instead, so
// the folder named is the folder used.
//
// REQUIRED, NOT IMPORTED. Playwright's entry is CommonJS, and `await import()`
// of its resolved path yields a module whose only key is `default`: `chromium`
// comes back undefined and the failure surfaces much later, as a launch on
// undefined. require() returns module.exports, which is what every caller wants.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const INSTALL = "cd tools/landing-shot && npm i";
const WORKTREE = "from a git worktree, set SIP_PLAYWRIGHT_DIR=<main checkout>/tools/landing-shot (NODE_PATH does not work: ESM resolution ignores it)";

/**
 * The folders to resolve "playwright" from, or null for Node's own resolution
 * relative to this file. An unset or empty variable is not a folder.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[] | null}
 */
export function playwrightSearchPaths(env = process.env) {
  const dir = env.SIP_PLAYWRIGHT_DIR;
  return dir === undefined || dir === "" ? null : [dir];
}

/**
 * The Playwright module, loaded from SIP_PLAYWRIGHT_DIR when it names a folder
 * and from this tool's own node_modules otherwise. Throws with the recipe rather
 * than a bare resolution error, and refuses anything that is not Playwright —
 * a wrong folder should not surface as `chromium.launch is not a function`.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function loadPlaywright(env = process.env) {
  const paths = playwrightSearchPaths(env);
  let module;
  try {
    module = paths === null ? require("playwright") : require(require.resolve("playwright", { paths }));
  } catch (error) {
    const cause = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      paths === null
        ? `playwright is not installed for this tool (${cause}). Install it with \`${INSTALL}\`, or ${WORKTREE}.`
        : `SIP_PLAYWRIGHT_DIR names ${paths[0]}, which has no node_modules/playwright (${cause}). Install it there with \`${INSTALL}\`.`,
    );
  }
  if (typeof module?.chromium?.launch !== "function") {
    const where = paths === null ? "this tool's own node_modules" : `SIP_PLAYWRIGHT_DIR (${paths[0]})`;
    throw new Error(`what ${where} resolved as "playwright" has no chromium.launch, so it is not Playwright.`);
  }
  return module;
}
